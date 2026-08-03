import { join, resolve } from "node:path";
import { stdin, stderr, stdout } from "node:process";
import { createInterface, type Interface } from "node:readline/promises";
import type { AgentModel, AgentRuntime, AgentRuntimeCommand } from "../../contracts.js";
import {
  createDefaultToolPolicy,
  createLifecycleRunner,
  InMemoryEventStore,
  InMemoryRuntimeLogStore,
  InMemoryRuntimeStateStore,
  InMemoryRunStore,
  LocalConversationStateStore,
  createConversationCompactionPlan,
  createLlmConversationSummarizer,
  createToolRuntime,
  createCompositeCompactionPolicy,
  formatAgentDefinition,
  projectToolCallRecordsFromEvents,
  assessRuntimeRecovery,
  PiAgentRuntimeFactory,
  type AgentExecutionOutcome,
  type AgentRuntimeEvent,
  type AgentRuntimeStateSnapshot,
  type LifecycleHooks,
} from "../../index.js";
import {
  createDefaultPromptTemplateRegistry,
  type PromptTemplateRegistry,
} from "../../prompt/prompt-template.js";
import type { AgentResourceRegistry } from "../../resources/resource-catalog.js";
import type { AgentToolRegistry } from "../../tools/tool-registry.js";
import type {
  ToolApprovalHandler,
} from "../../tools/policy/index.js";
import type { ToolRuntimeEvent } from "../../tools/tool-runtime.js";
import { RuntimeAssembler } from "../../runtime/runtime-assembler.js";
import { createUserMessage } from "../../runtime/messages.js";

type ApprovalMode = "ask" | "always" | "never";
type EventMode = "off" | "on" | "json";
type LifecycleMode = "off" | "on" | "json";
type CompactionSummarizerMode = "fallback" | "llm";

const PLAYGROUND_COMMANDS = new Set([
  "help",
  "tools",
  "templates",
  "template",
  "policy",
  "approve",
  "events",
  "eventlog",
  "toolcalls",
  "runtime",
  "runtimelog",
  "compact",
  "lifecycle",
  "runs",
  "state",
  "save",
  "delete",
  "storage",
  "context",
  "snapshot",
  "system",
  "reset",
  "exit",
  "quit",
]);

export type AgentPlaygroundOptions = {
  model: AgentModel;
  resolveApiKey: (provider: string) => string | undefined | Promise<string | undefined>;
  resourceRegistry: AgentResourceRegistry;
  toolRegistry: AgentToolRegistry;
  promptTemplateRegistry?: PromptTemplateRegistry;
  workingDirectory?: string;
  conversationFile?: string;
};

type PlaygroundState = {
  workingDirectory: string;
  availableToolNames: string[];
  toolNames: string[];
  resourceNames: string[];
  promptTemplateRegistry: PromptTemplateRegistry;
  policyEnabled: boolean;
  compactionEnabled: boolean;
  compactionProtectLastMessages: number;
  compactionSummarizerMode: CompactionSummarizerMode;
  approvalMode: ApprovalMode;
  eventMode: EventMode;
  lifecycleMode: LifecycleMode;
  runtime: AgentRuntime;
  lastSystemPrompt: string;
  localStore: LocalConversationStateStore;
  conversationFile: string;
  runStore: InMemoryRunStore;
  eventStore: InMemoryEventStore;
  runtimeStateStore: InMemoryRuntimeStateStore;
  runtimeLogStore: InMemoryRuntimeLogStore;
  runtimeRecorder: PlaygroundRuntimeRecorder;
  runRecorder: PlaygroundRunRecorder;
  nextRunSequence: number;
  nextRuntimeLogSequence: number;
};

type PlaygroundRunRecorder = {
  activeRun?: {
    runId: string;
    nextEventSequence: number;
  };
};

type PlaygroundRuntimeRecorder = {
  activeCommand?: {
    commandId: string;
    runId: string;
    command: AgentRuntimeCommand;
    startedAt: string;
  };
};

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

  const workingDirectory = options.workingDirectory ?? process.cwd();
  const conversationFile = options.conversationFile ?? resolvePlaygroundConversationFile(workingDirectory);
  const localStore = new LocalConversationStateStore({ stateFile: conversationFile });
  const runStore = new InMemoryRunStore();
  const eventStore = new InMemoryEventStore();
  const runtimeStateStore = new InMemoryRuntimeStateStore();
  const runtimeLogStore = new InMemoryRuntimeLogStore();
  const runRecorder: PlaygroundRunRecorder = {};
  const runtimeRecorder: PlaygroundRuntimeRecorder = {};
  const restoredFile = await localStore.load();
  const promptTemplateRegistry = options.promptTemplateRegistry ?? createDefaultPromptTemplateRegistry();

  const rebuildRuntime = (preserveState = true, restoredState?: ReturnType<AgentRuntime["exportState"]>) => {
    const previousState = restoredState ?? (preserveState ? state?.runtime.exportState() : undefined);
    const next = createRuntimeState(options, rl, {
      workingDirectory: state?.workingDirectory ?? workingDirectory,
      availableToolNames: state?.availableToolNames ?? options.toolRegistry.getAllEntries().map((entry) => entry.tool.name),
      toolNames: state?.toolNames ?? options.toolRegistry.getAllEntries().map((entry) => entry.tool.name),
      resourceNames: state?.resourceNames ?? options.resourceRegistry.getAllDefinitions().map((resource) => resource.name),
      promptTemplateRegistry,
      policyEnabled: state?.policyEnabled ?? true,
      compactionEnabled: state?.compactionEnabled ?? false,
      compactionProtectLastMessages: state?.compactionProtectLastMessages ?? 6,
      compactionSummarizerMode: state?.compactionSummarizerMode ?? "llm",
      approvalMode: state?.approvalMode ?? "ask",
      eventMode: state?.eventMode ?? "on",
      lifecycleMode: state?.lifecycleMode ?? "off",
      localStore,
      conversationFile,
      runStore: state?.runStore ?? runStore,
      eventStore: state?.eventStore ?? eventStore,
      runtimeStateStore: state?.runtimeStateStore ?? runtimeStateStore,
      runtimeLogStore: state?.runtimeLogStore ?? runtimeLogStore,
      runtimeRecorder,
      runRecorder,
      nextRunSequence: state?.nextRunSequence ?? 1,
      nextRuntimeLogSequence: state?.nextRuntimeLogSequence ?? 1,
    }, previousState);
    state = next;
  };

  rebuildRuntime(false, restoredFile?.agentState);
  await saveRuntimeSnapshot(state!, "idle", "clean");
  printIntro(state);
  if (restoredFile) {
    stdout.write(`restored conversation file: ${conversationFile}\n`);
  } else {
    stdout.write(`conversation file: ${conversationFile}\n`);
  }

  const lines = rl[Symbol.asyncIterator]();
  while (state) {
    stdout.write("agent> ");
    const input = await lines.next();
    if (input.done) break;
    const line = input.value.trim();
    if (!line) continue;
    if (line === "/exit" || line === "/quit") break;

    if (isPlaygroundCommand(line)) {
      const shouldContinue = await handleCommand(line, state, rebuildRuntime);
      if (!shouldContinue) break;
      continue;
    }

    const run = await startPlaygroundRun(state, "prompt");
    await markRuntimeCommandAccepted(state, run.runId, run.commandId, { type: "prompt", text: line });
    let outcome: AgentExecutionOutcome;
    try {
      outcome = await state.runtime.execute({ type: "prompt", text: line });
    } catch (error) {
      outcome = {
        status: "failed",
        errorCode: "PLAYGROUND_RUN_FAILED",
        message: readErrorMessage(error),
      };
    }
    await finishPlaygroundRun(state, run.runId, outcome);
    if (outcome.status === "failed" || outcome.status === "commit_failed") {
      await markRuntimeCommandFinished(state, outcome);
      stderr.write(`${outcome.errorCode}: ${outcome.message}\n`);
    } else if (outcome.status === "aborted") {
      const commitOutcome = await commitPlaygroundConversationState(state);
      await markRuntimeCommandFinished(state, commitOutcome);
      if (commitOutcome.status === "commit_failed") {
        stderr.write(`${commitOutcome.errorCode}: ${commitOutcome.message}\n`);
      } else {
        stderr.write("Run aborted.\n");
      }
    } else {
      const commitOutcome = await commitPlaygroundConversationState(state);
      await markRuntimeCommandFinished(state, commitOutcome);
      if (commitOutcome.status === "commit_failed") {
        stderr.write(`${commitOutcome.errorCode}: ${commitOutcome.message}\n`);
      }
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
    resourceRegistry: options.resourceRegistry,
    toolRegistry: options.toolRegistry,
    toolRuntime,
    lifecycleHooks,
    policies: {
      queue: "direct",
      retry: "none",
      compaction: config.compactionEnabled
        ? createCompositeCompactionPolicy({
          targetPressure: 0.7,
          protectLastMessages: config.compactionProtectLastMessages,
        })
        : "disabled",
    },
    resolveApiKey: options.resolveApiKey,
    ...(config.compactionSummarizerMode === "llm"
      ? {
        // playground 用结构化摘要作为默认 LLM 模式，方便人工观察 facts /
        // decisions / currentTaskState 等字段质量；core API 默认仍保持 text 兼容。
        conversationSummarizer: createLlmConversationSummarizer({
          model: options.model,
          resolveApiKey: options.resolveApiKey,
          outputFormat: "structured-json",
          ...resolvePlaygroundSummarizerInputBudget(options.model),
        }),
      }
      : {}),
  });
  const runtime = factory.create("agent-core-playground", conversationState);
  runtime.subscribe((event) => {
    recordRuntimeEvent(config, event);
    printRuntimeEvent(event, config.eventMode);
  });

  return {
    ...config,
    runtime,
    lastSystemPrompt: createSystemPromptPreview(options, definition, options.resourceRegistry, options.toolRegistry, toolRuntime, lifecycleHooks),
  };
}

function resolvePlaygroundSummarizerInputBudget(
  model: AgentModel,
): { maxInputTokens: number } | Record<string, never> {
  const contextWindow = (model as { contextWindow?: unknown }).contextWindow;
  if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow < 1) {
    return {};
  }
  // 摘要器也有自己的 prompt。这里保守使用模型上下文窗口的一半，避免“为了压缩主
  // 对话，先把摘要调用本身撑爆”。真实效果后续还要结合模型和长会话调参。
  return {
    maxInputTokens: Math.max(1, Math.floor(contextWindow * 0.5)),
  };
}

function createPlaygroundLifecycleHooks(mode: LifecycleMode): LifecycleHooks {
  if (mode === "off") return {};

  return {
    onInput: [({ command, metadata }) => {
      printLifecycleEvent(mode, "onInput", {
        commandType: command.type,
        ...(metadata ? { metadata } : {}),
      });
      return { action: "continue" };
    }],
    beforeRun: [({ command, systemPrompt, metadata }) => {
      printLifecycleEvent(mode, "beforeRun", {
        commandType: command.type,
        systemPromptLength: systemPrompt.length,
        ...(metadata ? { metadata } : {}),
      });
      if (readSlashCommand(metadata) !== "review") return;
      return {
        systemPrompt: [
          systemPrompt,
          "",
          "本轮 slash command: review。",
          "请以代码审查口吻回答，优先指出 bug、风险、行为回归和缺失测试。",
        ].join("\n"),
      };
    }],
    beforeContext: [({ messages, systemPrompt, metadata }) => {
      printLifecycleEvent(mode, "beforeContext", {
        messageCount: messages.length,
        systemPromptLength: systemPrompt.length,
        ...(metadata ? { metadata } : {}),
      });
      if (readSlashCommand(metadata) !== "review") return;
      const target = readRawArgs(metadata) ?? "当前输入";
      return {
        messages: [
          ...messages,
          createUserMessage(`临时上下文：请 review ${target}，并用 findings-first 的结构输出。`),
        ],
      };
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
    afterRun: [({ status, metadata }) => {
      printLifecycleEvent(mode, "afterRun", {
        status,
        ...(metadata ? { metadata } : {}),
      });
    }],
  };
}

function isPlaygroundCommand(line: string) {
  if (!line.startsWith("/")) return false;
  const command = line.slice(1).split(/\s+/, 1)[0] ?? "";
  return PLAYGROUND_COMMANDS.has(command);
}

function readSlashCommand(metadata: Record<string, unknown> | undefined): string | undefined {
  return typeof metadata?.slashCommand === "string"
    ? metadata.slashCommand
    : undefined;
}

function readRawArgs(metadata: Record<string, unknown> | undefined): string | undefined {
  const args = metadata?.args;
  if (!args || typeof args !== "object" || !("raw" in args)) return undefined;
  return typeof args.raw === "string" ? args.raw : undefined;
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
    state.toolNames = parseNameList(value, state.availableToolNames);
    rebuildRuntime(true);
    stdout.write(`tools: ${state.toolNames.join(", ") || "(none)"}\n`);
    return true;
  }
  if (command === "templates") {
    printPromptTemplates(state.promptTemplateRegistry);
    return true;
  }
  if (command === "template") {
    printPromptTemplate(state.promptTemplateRegistry, value);
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
  if (command === "eventlog") {
    await printStoredEvents(state, value);
    return true;
  }
  if (command === "toolcalls") {
    await printStoredToolCalls(state, value);
    return true;
  }
  if (command === "runtime") {
    await printRuntimeState(state);
    return true;
  }
  if (command === "runtimelog") {
    await printRuntimeLog(state);
    return true;
  }
  if (command === "compact") {
    await handleCompactCommand(state, value, rebuildRuntime);
    return true;
  }
  if (command === "lifecycle") {
    state.lifecycleMode = parseLifecycleMode(value);
    rebuildRuntime(true);
    stdout.write(`lifecycle: ${state.lifecycleMode}\n`);
    return true;
  }
  if (command === "runs") {
    await printStoredRuns(state);
    return true;
  }
  if (command === "state") {
    stdout.write(`${JSON.stringify(state.runtime.exportState(), null, 2)}\n`);
    return true;
  }
  if (command === "save") {
    const file = await savePlaygroundState(state);
    stdout.write(`saved: ${file}\n`);
    return true;
  }
  if (command === "delete") {
    const deleted = await state.localStore.delete();
    stdout.write(deleted ? `deleted: ${state.conversationFile}\n` : `not found: ${state.conversationFile}\n`);
    return true;
  }
  if (command === "storage") {
    stdout.write(`conversation file: ${state.conversationFile}\n`);
    return true;
  }
  if (command === "context") {
    stdout.write(`${JSON.stringify(state.runtime.inspectContext() ?? null, null, 2)}\n`);
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
  resourceRegistry: AgentResourceRegistry,
  toolRegistry: AgentToolRegistry,
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

async function startPlaygroundRun(
  state: PlaygroundState,
  commandType: AgentRuntimeCommand["type"],
) {
  const sequence = state.nextRunSequence;
  state.nextRunSequence += 1;
  const runId = `playground-run-${sequence}`;
  const commandId = `playground-command-${sequence}`;
  state.runRecorder.activeRun = {
    runId,
    nextEventSequence: 1,
  };
  return state.runStore.start({
    runId,
    commandId,
    sessionId: "agent-core-playground",
    commandType,
    startedAt: new Date().toISOString(),
  });
}

async function markRuntimeCommandAccepted(
  state: PlaygroundState,
  runId: string,
  commandId: string,
  command: AgentRuntimeCommand,
) {
  const startedAt = new Date().toISOString();
  state.runtimeRecorder.activeCommand = {
    commandId,
    runId,
    command,
    startedAt,
  };
  await appendRuntimeLog(state, "command_accepted", {
    commandId,
    runId,
    command,
  });
  await saveRuntimeSnapshot(state, "running", "dirty");
}

async function markRuntimeCommandFinished(
  state: PlaygroundState,
  outcome: AgentExecutionOutcome,
) {
  const activeCommand = state.runtimeRecorder.activeCommand;
  if (!activeCommand) return;
  await appendRuntimeLog(state, outcome.status === "commit_failed" ? "state_commit_failed" : "command_finished", {
    commandId: activeCommand.commandId,
    runId: activeCommand.runId,
    outcome,
  });
  delete state.runtimeRecorder.activeCommand;
  await saveRuntimeSnapshot(
    state,
    outcome.status === "commit_failed"
      ? "commit_failed"
      : outcome.status === "failed"
        ? "failed"
        : "idle",
    outcome.status === "commit_failed" ? "commit_failed" : "clean",
  );
}

async function commitPlaygroundConversationState(
  state: PlaygroundState,
): Promise<AgentExecutionOutcome> {
  try {
    await savePlaygroundState(state);
    return { status: "succeeded" };
  } catch (error) {
    return {
      status: "commit_failed",
      errorCode: "PLAYGROUND_STATE_COMMIT_FAILED",
      message: readErrorMessage(error),
    };
  }
}

async function finishPlaygroundRun(
  state: PlaygroundState,
  runId: string,
  outcome: AgentExecutionOutcome,
) {
  const status = outcome.status;
  try {
    await state.runStore.finish(runId, {
      status,
      outcome,
      endedAt: new Date().toISOString(),
    });
  } finally {
    delete state.runRecorder.activeRun;
  }
}

async function saveRuntimeSnapshot(
  state: PlaygroundState,
  status: AgentRuntimeStateSnapshot["status"],
  dirtyState: AgentRuntimeStateSnapshot["dirtyState"],
) {
  const activeCommand = state.runtimeRecorder.activeCommand;
  const snapshot: AgentRuntimeStateSnapshot = {
    snapshotId: `playground-runtime-snapshot-${state.nextRuntimeLogSequence}`,
    sessionId: "agent-core-playground",
    status,
    dirtyState,
    ...(activeCommand
      ? {
          activeCommand: {
            commandId: activeCommand.commandId,
            runId: activeCommand.runId,
            command: activeCommand.command,
            startedAt: activeCommand.startedAt,
          },
        }
      : {}),
    queuedCommands: [],
    lastCommittedStateVersion: state.runtime.exportState().schemaVersion,
    updatedAt: new Date().toISOString(),
  };
  await state.runtimeStateStore.save(snapshot);
  await appendRuntimeLog(state, "runtime_snapshot_saved", snapshot);
}

async function appendRuntimeLog(
  state: PlaygroundState,
  type: Parameters<InMemoryRuntimeLogStore["append"]>[0]["type"],
  payload: unknown,
) {
  const sequence = state.nextRuntimeLogSequence;
  state.nextRuntimeLogSequence += 1;
  await state.runtimeLogStore.append({
    entryId: `playground-runtime-log-${sequence}`,
    sessionId: "agent-core-playground",
    sequence,
    type,
    payload,
    createdAt: new Date().toISOString(),
  });
}

function recordRuntimeEvent(
  config: Pick<PlaygroundState, "eventStore" | "runRecorder">,
  event: AgentRuntimeEvent,
) {
  const activeRun = config.runRecorder.activeRun;
  if (!activeRun) return;
  const sequence = activeRun.nextEventSequence;
  activeRun.nextEventSequence += 1;
  void config.eventStore.append({
    eventId: `${activeRun.runId}:event:${sequence}`,
    runId: activeRun.runId,
    sessionId: event.sessionId,
    sequence,
    type: event.type,
    payload: event,
    retention: isRequiredRuntimeEvent(event) ? "required" : "diagnostic",
    createdAt: new Date().toISOString(),
  }).catch((error: unknown) => {
    stderr.write(`event store append failed: ${readErrorMessage(error)}\n`);
  });
}

async function printStoredRuns(state: PlaygroundState) {
  const runs = await state.runStore.listBySession("agent-core-playground");
  if (runs.length === 0) {
    stdout.write("runs: (none)\n");
    return;
  }
  stdout.write(`${JSON.stringify(runs, null, 2)}\n`);
}

function printPromptTemplates(registry: PromptTemplateRegistry) {
  const templates = registry.getAllDefinitions();
  if (templates.length === 0) {
    stdout.write("templates: (none)\n");
    return;
  }
  stdout.write(`templates: ${templates.map((template) => template.name).join(", ")}\n`);
}

function printPromptTemplate(registry: PromptTemplateRegistry, name: string) {
  if (!name) {
    stdout.write('/template expects a template name, for example "/template review".\n');
    return;
  }
  const template = registry.getDefinition(name);
  if (!template) {
    stdout.write(`template not found: ${name}\n`);
    return;
  }
  stdout.write([
    `template: ${template.name}`,
    `source: ${template.sourceInfo.label}`,
    "",
    template.content,
    "",
  ].join("\n"));
}

async function printStoredEvents(state: PlaygroundState, runId: string) {
  const events = runId
    ? await state.eventStore.listByRun(runId)
    : await state.eventStore.listBySession("agent-core-playground");
  if (events.length === 0) {
    stdout.write("events: (none)\n");
    return;
  }
  stdout.write(`${JSON.stringify(events, null, 2)}\n`);
}

async function printStoredToolCalls(state: PlaygroundState, runId: string) {
  const events = runId
    ? await state.eventStore.listByRun(runId)
    : await state.eventStore.listBySession("agent-core-playground");
  const records = projectToolCallRecordsFromEvents(events);
  if (records.length === 0) {
    stdout.write("tool calls: (none)\n");
    return;
  }
  stdout.write(`${JSON.stringify(records, null, 2)}\n`);
}

async function printRuntimeState(state: PlaygroundState) {
  const snapshot = await state.runtimeStateStore.get("agent-core-playground");
  if (!snapshot) {
    stdout.write("runtime: (none)\n");
    return;
  }
  stdout.write(`${JSON.stringify({
    snapshot,
    recovery: assessRuntimeRecovery(snapshot),
  }, null, 2)}\n`);
}

async function printRuntimeLog(state: PlaygroundState) {
  const entries = await state.runtimeLogStore.listBySession("agent-core-playground");
  if (entries.length === 0) {
    stdout.write("runtime log: (none)\n");
    return;
  }
  stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
}

async function runPlaygroundCompact(
  state: PlaygroundState,
  command: Extract<AgentRuntimeCommand, { type: "compact" }>,
) {
  const previewState = state.runtime.exportState();
  const previewPlan = createConversationCompactionPlan({
    entries: previewState.payload.entries,
    leafId: previewState.payload.leafId,
    reason: command.reason ?? "manual",
    ...(command.keepLastMessages === undefined
      ? {}
      : { keepLastMessages: command.keepLastMessages }),
    createdBy: "runtime",
  });
  const run = await startPlaygroundRun(state, "compact");
  await markRuntimeCommandAccepted(state, run.runId, run.commandId, command);
  let outcome: AgentExecutionOutcome;
  try {
    outcome = await state.runtime.execute(command);
  } catch (error) {
    outcome = {
      status: "failed",
      errorCode: "PLAYGROUND_COMPACT_FAILED",
      message: readErrorMessage(error),
    };
  }
  await finishPlaygroundRun(state, run.runId, outcome);
  if (outcome.status === "failed" || outcome.status === "commit_failed") {
    await markRuntimeCommandFinished(state, outcome);
    stderr.write(`${outcome.errorCode}: ${outcome.message}\n`);
    return;
  }

  const commitOutcome = await commitPlaygroundConversationState(state);
  await markRuntimeCommandFinished(state, commitOutcome);
  if (commitOutcome.status === "commit_failed") {
    stderr.write(`${commitOutcome.errorCode}: ${commitOutcome.message}\n`);
    return;
  }
  stdout.write("compacted.\n");
  if (previewPlan?.selection) {
    stdout.write(formatCompactionStageTrace(previewPlan.selection));
  }
}

function formatCompactionStageTrace(
  selection: NonNullable<ReturnType<typeof createConversationCompactionPlan>>["selection"],
) {
  if (!selection) return "";
  return `compaction stages:\n${JSON.stringify({
    compactionStages: selection.stageResults,
    selectedEntryIds: selection.selectedEntryIds,
    preservedEntryIds: selection.preservedEntryIds,
    selectedEstimatedTokens: selection.selectedEstimatedTokens,
    estimatedTokensBefore: selection.estimatedTokensBefore,
    estimatedTokensAfterTarget: selection.estimatedTokensAfterTarget,
  }, null, 2)}\n`;
}

async function savePlaygroundState(state: PlaygroundState) {
  await state.localStore.save({
    sessionId: "agent-core-playground",
    agentState: state.runtime.exportState(),
    sessionInfo: {
      cwd: state.workingDirectory,
      modelId: state.runtime.snapshot().modelId
    }
  });
  return state.conversationFile;
}

function isRequiredRuntimeEvent(event: AgentRuntimeEvent) {
  return event.type === "run_started"
    || event.type === "run_finished"
    || event.type === "run_aborted"
    || event.type === "run_failed"
    || event.type === "message_finished"
    || event.type === "tool_started"
    || event.type === "tool_finished";
}

function resolvePlaygroundConversationFile(cwd: string) {
  return join(resolve(cwd), ".agent-platform", "playground", "sessions", "agent-core-playground", "state.json");
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
    stderr.write(`${JSON.stringify({ source: "lifecycle", hook, data }, null, 2)}\n`);
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

async function handleCompactCommand(
  state: PlaygroundState,
  value: string,
  rebuildRuntime: (preserveState?: boolean) => void,
) {
  if (!value || value === "status") {
    stdout.write(formatCompactStatus(state));
    return;
  }

  if (value === "run") {
    await runPlaygroundCompact(state, { type: "compact", reason: "manual" });
    return;
  }
  const runMatch = value.match(/^run\s+keep\s+(\d+)$/);
  if (runMatch?.[1]) {
    await runPlaygroundCompact(state, {
      type: "compact",
      reason: "manual",
      keepLastMessages: Number(runMatch[1]),
    });
    return;
  }

  const autoMatch = value.match(/^auto\s+(on|off|status)$/);
  if (autoMatch?.[1]) {
    if (autoMatch[1] !== "status") {
      state.compactionEnabled = autoMatch[1] === "on";
      rebuildRuntime(true);
    }
    stdout.write(formatCompactStatus(state));
    return;
  }

  const protectMatch = value.match(/^auto\s+protect\s+(\d+)$/);
  if (protectMatch?.[1]) {
    state.compactionProtectLastMessages = Number(protectMatch[1]);
    rebuildRuntime(true);
    stdout.write(formatCompactStatus(state));
    return;
  }

  const summarizerMatch = value.match(/^summarizer\s+(fallback|llm|status)$/);
  if (summarizerMatch?.[1]) {
    const mode = parseCompactionSummarizerMode(summarizerMatch[1]);
    if (mode) {
      // 切换 summarizer 后必须 rebuild runtime，因为 summarizer 是注入
      // PiAgentRuntimeFactory / AgentRuntimeSession 的运行态依赖。
      state.compactionSummarizerMode = mode;
      rebuildRuntime(true);
    }
    stdout.write(formatCompactStatus(state));
    return;
  }

  throw new Error('/compact expects "status", "run [keep N]", "auto on|off|status", "auto protect <number>", or "summarizer fallback|llm|status".');
}

function formatCompactStatus(state: PlaygroundState) {
  return `compact: auto=${state.compactionEnabled ? "on" : "off"}, protectLast=${state.compactionProtectLastMessages}, summarizer=${state.compactionSummarizerMode}\n`;
}

function parseCompactionSummarizerMode(value: string): CompactionSummarizerMode | undefined {
  if (value === "fallback" || value === "llm") return value;
  if (value === "status") return undefined;
  throw new Error('/compact summarizer expects "fallback", "llm", or "status".');
}

function formatLifecycleValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function printIntro(state: PlaygroundState | undefined) {
  stdout.write("Agent Runtime Playground\n");
  stdout.write("Type /help for commands, /exit to quit.\n");
  if (state) {
    stdout.write(`cwd: ${state.workingDirectory}\n`);
    stdout.write(`tools: ${state.toolNames.join(", ")}\n`);
    stdout.write(`templates: ${state.promptTemplateRegistry.getAllDefinitions().map((template) => template.name).join(", ") || "(none)"}\n`);
    stdout.write(`policy: ${state.policyEnabled ? "on" : "off"}, approve: ${state.approvalMode}, events: ${state.eventMode}, lifecycle: ${state.lifecycleMode}\n`);
    stdout.write(formatCompactStatus(state));
  }
}

function printHelp() {
  stdout.write(`Commands:
  /tools                 Show enabled tools.
  /tools all             Enable all registered tools.
  /tools none            Disable all tools.
  /tools inspect_runtime Enable selected registered tools.
  /templates             Show discovered prompt templates.
  /template review       Print one prompt template.
  /policy on|off         Toggle default ToolPolicy.
  /approve ask|always|never
  /events on|off|json    Toggle runtime and ToolRuntime event printing.
  /eventlog [runId]      Print stored EventStore records.
  /toolcalls [runId]     Print projected tool call recovery records.
  /runtime               Print runtime state snapshot and recovery assessment.
  /runtimelog            Print append-only runtime log entries.
  /compact status        Print compaction settings.
  /compact run [keep N]  Manually compact older conversation messages.
  /compact auto on|off   Toggle automatic composite compaction.
  /compact auto protect N
                         Protect N latest messages when auto compaction runs.
  /compact summarizer llm|fallback
                         Choose LLM-driven or deterministic fallback summaries.
  /lifecycle on|off|json Toggle LifecycleRunner hook logging.
  /runs                  Print stored RunStore records.
  /state                 Print exported conversation state.
  /save                  Save conversation state to local storage.
  /delete                Delete the saved local conversation state.
  /storage               Print the local conversation file path.
  /context               Print the last assembled prompt context.
  /snapshot              Print runtime snapshot.
  /system                Print current assembled system prompt.
  /reset                 Reset conversation session.
  /exit                  Quit.

Any non-command line, plus slash-prefixed lines that are not playground
commands, is sent as a prompt to the current AgentRuntime.
`);
}
