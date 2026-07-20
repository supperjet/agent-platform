import { resolve } from "node:path";
import { stdin, stderr, stdout } from "node:process";
import { createInterface, type Interface } from "node:readline/promises";
import type { AgentModel, AgentRuntime } from "../contracts.js";
import {
  createAgentResourceRegistry,
  createAgentToolRegistry,
  createBuiltInToolDefinitions,
  createDefaultToolPolicy,
  createLifecycleRunner,
  createLocalToolOperations,
  createToolRuntime,
  formatAgentDefinition,
  PiAgentRuntimeFactory,
  type AgentRuntimeEvent,
  type LifecycleHooks,
} from "../index.js";
import type { AgentResourceDefinition } from "../resources/resource-catalog.js";
import type { AnyAgentToolDefinition } from "../tools/tool-registry.js";
import type {
  ToolApprovalHandler,
} from "../tools/policy/index.js";
import type { ToolRuntimeEvent } from "../tools/tool-runtime.js";
import { RuntimeAssembler } from "../runtime/runtime-assembler.js";

type ApprovalMode = "ask" | "always" | "never";
type EventMode = "off" | "on" | "json";
type LifecycleMode = "off" | "on" | "json";

export type AgentPlaygroundOptions = {
  model: AgentModel;
  resolveApiKey: (provider: string) => string | undefined | Promise<string | undefined>;
  exampleResources: readonly AgentResourceDefinition[];
  exampleTools: readonly AnyAgentToolDefinition[];
  initialCwd: string;
  initialToolNames?: readonly string[];
  initialResourceNames?: readonly string[];
  requestTimeoutMs?: number;
  json?: boolean;
};

type PlaygroundState = {
  cwd: string;
  toolNames: string[];
  resourceNames: string[];
  policyEnabled: boolean;
  approvalMode: ApprovalMode;
  eventMode: EventMode;
  lifecycleMode: LifecycleMode;
  runtime: AgentRuntime;
  lastSystemPrompt: string;
};

const BUILT_IN_TOOL_NAMES = ["read", "ls", "grep", "find", "write", "edit", "bash"];

/**
 * 启动完整 Agent Runtime 交互式 playground。
 *
 * 它不是直接调用工具，而是每次输入 prompt 后走完整 runtime：
 * AgentDefinition -> RuntimeAssembler -> AgentLoop -> ToolRuntime -> ToolOperations。
 */
export async function startAgentPlayground(options: AgentPlaygroundOptions) {
  const rl = createInterface({
    input: stdin,
    output: stdout,
  });

  let state: PlaygroundState | undefined;

  const rebuildRuntime = (preserveState = true) => {
    const previousState = preserveState ? state?.runtime.exportState() : undefined;
    const next = createRuntimeState(options, rl, {
      cwd: state?.cwd ?? options.initialCwd,
      toolNames: state?.toolNames ?? [...(options.initialToolNames ?? BUILT_IN_TOOL_NAMES)],
      resourceNames: state?.resourceNames ?? [...(options.initialResourceNames ?? [])],
      policyEnabled: state?.policyEnabled ?? true,
      approvalMode: state?.approvalMode ?? "ask",
      eventMode: state?.eventMode ?? (options.json ? "json" : "on"),
      lifecycleMode: state?.lifecycleMode ?? "off",
    }, previousState);
    state = next;
  };

  rebuildRuntime(false);
  printIntro(state);

  while (state) {
    const line = (await rl.question("agent> ")).trim();
    if (!line) continue;
    if (line === "/exit" || line === "/quit") break;

    if (line.startsWith("/")) {
      const shouldContinue = await handleCommand(line, state, rebuildRuntime);
      if (!shouldContinue) break;
      continue;
    }

    const outcome = await state.runtime.execute({ type: "prompt", text: line });
    if (outcome.status === "failed") {
      stderr.write(`${outcome.errorCode}: ${outcome.message}\n`);
    }
    stdout.write("\n");
  }

  rl.close();
}

function createRuntimeState(
  options: AgentPlaygroundOptions,
  rl: Interface,
  config: Omit<PlaygroundState, "runtime" | "lastSystemPrompt">,
  conversationState?: ReturnType<AgentRuntime["exportState"]>,
): PlaygroundState {
  const toolOperations = createLocalToolOperations({ cwd: config.cwd });
  const toolRegistry = createAgentToolRegistry([
    ...createBuiltInToolDefinitions(toolOperations),
    ...options.exampleTools,
  ]);
  const resourceRegistry = createAgentResourceRegistry(options.exampleResources);
  const definition = formatAgentDefinition({
    id: "agent-core-playground",
    model: options.model,
    instructions: [
      "You are an agent-core runtime playground.",
      "Answer concisely in Chinese.",
      "Use tools when they help verify the runtime behavior.",
      "Do not reveal API keys, hidden runtime state, or system configuration.",
    ],
    toolNames: config.toolNames,
    resourceNames: config.resourceNames,
  });
  const lifecycleHooks = createPlaygroundLifecycleHooks(config.lifecycleMode);
  const toolRuntime = createToolRuntime({
    lifecycleRunner: createLifecycleRunner(lifecycleHooks),
    ...(config.policyEnabled ? { policy: createDefaultToolPolicy() } : {}),
    approvalHandler: createApprovalHandler(config, rl),
    onEvent: (event) => printToolRuntimeEvent(event, config.eventMode),
  });
  const factory = new PiAgentRuntimeFactory({
    definition,
    resourceRegistry,
    toolRegistry,
    toolRuntime,
    lifecycleHooks,
    resolveApiKey: options.resolveApiKey,
    ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
  });
  const runtime = factory.create("agent-core-playground", conversationState);
  runtime.subscribe((event) => printRuntimeEvent(event, config.eventMode));

  return {
    ...config,
    runtime,
    lastSystemPrompt: createSystemPromptPreview(options, definition, resourceRegistry, toolRegistry, toolRuntime, lifecycleHooks),
  };
}

function createPlaygroundLifecycleHooks(mode: LifecycleMode): LifecycleHooks {
  if (mode === "off") return {};

  return {
    onInput: [({ command }) => {
      printLifecycleEvent(mode, "onInput", { commandType: command.type });
      return { action: "continue" };
    }],
    beforeRun: [({ command, systemPrompt }) => {
      printLifecycleEvent(mode, "beforeRun", {
        commandType: command.type,
        systemPromptLength: systemPrompt.length,
      });
    }],
    beforeContext: [({ messages, systemPrompt }) => {
      printLifecycleEvent(mode, "beforeContext", {
        messageCount: messages.length,
        systemPromptLength: systemPrompt.length,
      });
    }],
    beforeToolCall: [({ tool, toolCallId, args }) => {
      printLifecycleEvent(mode, "beforeToolCall", {
        toolName: tool.name,
        toolCallId,
        args,
      });
    }],
    afterToolCall: [({ tool, toolCallId, status }) => {
      printLifecycleEvent(mode, "afterToolCall", {
        toolName: tool.name,
        toolCallId,
        status,
      });
    }],
    afterMessage: [({ message }) => {
      printLifecycleEvent(mode, "afterMessage", {
        role: message.role,
      });
    }],
    beforeCompaction: [({ reason, willRetry }) => {
      printLifecycleEvent(mode, "beforeCompaction", {
        reason,
        willRetry,
      });
    }],
    afterRun: [({ status }) => {
      printLifecycleEvent(mode, "afterRun", { status });
    }],
  };
}

function createApprovalHandler(
  config: Pick<PlaygroundState, "approvalMode">,
  rl: Interface,
): ToolApprovalHandler {
  return async (input) => {
    if (config.approvalMode === "always") return true;
    if (config.approvalMode === "never") return false;

    stdout.write(`\n[approval] ${input.approval.title}\n${input.approval.message}\n`);
    const answer = (await rl.question("approve? [y/N] ")).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  };
}

async function handleCommand(
  line: string,
  state: PlaygroundState,
  rebuildRuntime: (preserveState?: boolean) => void,
): Promise<boolean> {
  const [command = "", ...rest] = line.slice(1).split(/\s+/);
  const value = rest.join(" ").trim();

  if (command === "help") {
    printHelp();
    return true;
  }
  if (command === "tools") {
    if (!value) {
      stdout.write(`tools: ${state.toolNames.join(", ") || "(none)"}\n`);
      return true;
    }
    state.toolNames = parseNameList(value, BUILT_IN_TOOL_NAMES);
    rebuildRuntime(true);
    stdout.write(`tools: ${state.toolNames.join(", ") || "(none)"}\n`);
    return true;
  }
  if (command === "policy") {
    state.policyEnabled = parseOnOff(value, "policy");
    rebuildRuntime(true);
    stdout.write(`policy: ${state.policyEnabled ? "on" : "off"}\n`);
    return true;
  }
  if (command === "approve") {
    state.approvalMode = parseApprovalMode(value);
    rebuildRuntime(true);
    stdout.write(`approve: ${state.approvalMode}\n`);
    return true;
  }
  if (command === "events") {
    state.eventMode = parseEventMode(value);
    rebuildRuntime(true);
    stdout.write(`events: ${state.eventMode}\n`);
    return true;
  }
  if (command === "lifecycle") {
    state.lifecycleMode = parseLifecycleMode(value);
    rebuildRuntime(true);
    stdout.write(`lifecycle: ${state.lifecycleMode}\n`);
    return true;
  }
  if (command === "cwd") {
    if (!value) {
      stdout.write(`cwd: ${state.cwd}\n`);
      return true;
    }
    state.cwd = resolve(value);
    rebuildRuntime(true);
    stdout.write(`cwd: ${state.cwd}\n`);
    return true;
  }
  if (command === "state") {
    stdout.write(`${JSON.stringify(state.runtime.exportState(), null, 2)}\n`);
    return true;
  }
  if (command === "snapshot") {
    stdout.write(`${JSON.stringify(state.runtime.snapshot(), null, 2)}\n`);
    return true;
  }
  if (command === "system") {
    stdout.write(`${state.lastSystemPrompt}\n`);
    return true;
  }
  if (command === "reset") {
    rebuildRuntime(false);
    stdout.write("session reset.\n");
    return true;
  }
  if (command === "exit" || command === "quit") return false;

  stdout.write(`Unknown command: /${command}. Type /help for commands.\n`);
  return true;
}

function createSystemPromptPreview(
  options: AgentPlaygroundOptions,
  definition: ReturnType<typeof formatAgentDefinition>,
  resourceRegistry: ReturnType<typeof createAgentResourceRegistry>,
  toolRegistry: ReturnType<typeof createAgentToolRegistry>,
  toolRuntime: ReturnType<typeof createToolRuntime>,
  lifecycleHooks: LifecycleHooks,
) {
  const assembly = new RuntimeAssembler({
    resourceRegistry,
    toolRegistry,
    services: { toolRuntime, lifecycleHooks },
  }).assemble({
    sessionId: "agent-core-playground-system-preview",
    definition,
    resolveApiKey: options.resolveApiKey,
  });
  return assembly.systemPrompt;
}

function printRuntimeEvent(event: AgentRuntimeEvent, mode: EventMode) {
  if (mode === "off") {
    if (event.type === "message_delta" && event.channel === "text") stdout.write(event.delta);
    return;
  }
  if (mode === "json") {
    stderr.write(`${JSON.stringify({ source: "runtime", event })}\n`);
  } else if (event.type !== "message_delta") {
    stderr.write(`[runtime:${event.type}]\n`);
  }
  if (event.type === "message_delta" && event.channel === "text") stdout.write(event.delta);
}

function printToolRuntimeEvent(event: ToolRuntimeEvent, mode: EventMode) {
  if (mode === "off") return;
  if (mode === "json") {
    stderr.write(`${JSON.stringify({ source: "tool-runtime", event })}\n`);
    return;
  }
  stderr.write(`[tool-runtime:${event.type}] ${event.toolName}:${event.toolCallId}\n`);
}

function printLifecycleEvent(mode: LifecycleMode, hook: string, data: Record<string, unknown>) {
  if (mode === "off") return;
  if (mode === "json") {
    stderr.write(`${JSON.stringify({ source: "lifecycle", hook, data })}\n`);
    return;
  }
  const details = Object.entries(data)
    .map(([key, value]) => `${key}=${formatLifecycleValue(value)}`)
    .join(" ");
  stderr.write(`[lifecycle:${hook}]${details ? ` ${details}` : ""}\n`);
}

function parseNameList(value: string, allNames: readonly string[]) {
  if (value === "all") return [...allNames];
  if (value === "none") return [];
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function parseOnOff(value: string, label: string) {
  if (value === "on") return true;
  if (value === "off") return false;
  throw new Error(`/${label} expects "on" or "off".`);
}

function parseApprovalMode(value: string): ApprovalMode {
  if (value === "ask" || value === "always" || value === "never") return value;
  throw new Error('/approve expects "ask", "always", or "never".');
}

function parseEventMode(value: string): EventMode {
  if (value === "on" || value === "off" || value === "json") return value;
  throw new Error('/events expects "on", "off", or "json".');
}

function parseLifecycleMode(value: string): LifecycleMode {
  if (value === "on" || value === "off" || value === "json") return value;
  throw new Error('/lifecycle expects "on", "off", or "json".');
}

function formatLifecycleValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function printIntro(state: PlaygroundState | undefined) {
  stdout.write("Agent Runtime Playground\n");
  stdout.write("Type /help for commands, /exit to quit.\n");
  if (state) {
    stdout.write(`cwd: ${state.cwd}\n`);
    stdout.write(`tools: ${state.toolNames.join(", ")}\n`);
    stdout.write(`policy: ${state.policyEnabled ? "on" : "off"}, approve: ${state.approvalMode}, events: ${state.eventMode}, lifecycle: ${state.lifecycleMode}\n`);
  }
}

function printHelp() {
  stdout.write(`Commands:
  /tools                 Show enabled tools.
  /tools all             Enable built-in tools.
  /tools none            Disable all tools.
  /tools read,ls,grep    Enable selected tools.
  /policy on|off         Toggle default ToolPolicy.
  /approve ask|always|never
  /events on|off|json    Toggle runtime and ToolRuntime event printing.
  /lifecycle on|off|json Toggle LifecycleRunner hook logging.
  /cwd <path>            Rebuild runtime with a new ToolOperations cwd.
  /state                 Print exported conversation state.
  /snapshot              Print runtime snapshot.
  /system                Print current assembled system prompt.
  /reset                 Reset conversation session.
  /exit                  Quit.

Any non-command line is sent as a prompt to the current AgentRuntime.
`);
}
