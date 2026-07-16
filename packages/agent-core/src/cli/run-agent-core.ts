#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { stdin, stderr, stdout } from "node:process";
import { fauxAssistantMessage, fauxText, getModels, registerFauxProvider } from "@earendil-works/pi-ai";
import {
  createAgentResourceRegistry,
  createAgentToolRegistry,
  createBuiltInToolDefinitions,
  createDefaultToolPolicy,
  createToolRuntime,
  formatAgentDefinition,
  PiAgentRuntimeFactory,
  createLocalToolOperations,
  type AgentModel,
  type AgentRuntimeEvent
} from "../index.js";
import { ResourceCatalog } from "../resources/resource-catalog.js";
import { RuntimeAssembler } from "../runtime/runtime-assembler.js";
import { ToolCatalog } from "../tools/tool-catalog.js";
import { startAgentPlayground } from "./agent-playground.js";
import { exampleCliResources } from "./example-resources.js";
import { exampleCliTools } from "./example-tools.js";

type CliOptions = {
  json: boolean;
  faux: boolean;
  fauxResponse: string;
  exampleResources: boolean;
  exampleTools: boolean;
  modelId: string;
  agentPlayground: boolean;
  callTool?: string;
  approveToolCall: boolean;
  noToolPolicy: boolean;
  printResources: boolean;
  printState: boolean;
  printTools: boolean;
  printSystemPrompt: boolean;
  requestTimeoutMs: number | undefined;
  resourceNames: string[];
  toolArgs: unknown;
  toolCwd: string;
  toolNames: string[];
  prompt: string;
};

async function main() {
  loadDotEnv();
  const options = await parseArgs(process.argv.slice(2));
  if (!options.prompt.trim() && !options.agentPlayground && !options.callTool && !options.printSystemPrompt && !options.printTools && !options.printResources) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const registration = options.faux
    ? registerFauxProvider({ provider: "agent-core-cli-faux" })
    : undefined;

  if (registration) {
    registration.setResponses([fauxAssistantMessage(fauxText(options.fauxResponse))]);
  }

  try {
    const resourceRegistry = options.exampleResources
      ? createAgentResourceRegistry(exampleCliResources)
      : undefined;
    const toolOperations = createLocalToolOperations({ cwd: options.toolCwd });
    const toolRegistry = createAgentToolRegistry([
      ...createBuiltInToolDefinitions(toolOperations),
      ...(options.exampleTools ? exampleCliTools : [])
    ]);

    if (options.agentPlayground) {
      const model = registration ? registration.getModel() : getDeepSeekModel(options.modelId);
      const resolveApiKey = (provider: string) => {
        if (registration && provider === model.provider) return "faux-key";
        if (provider !== "deepseek") return undefined;
        return process.env.DEEPSEEK_API_KEY;
      };
      await startAgentPlayground({
        model,
        resolveApiKey,
        exampleResources: options.exampleResources ? exampleCliResources : [],
        exampleTools: options.exampleTools ? exampleCliTools : [],
        initialCwd: options.toolCwd,
        ...(options.toolNames.length > 0 ? { initialToolNames: options.toolNames } : {}),
        ...(options.resourceNames.length > 0 ? { initialResourceNames: options.resourceNames } : {}),
        ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
        json: options.json
      });
      return;
    }

    if (options.callTool) {
      await callToolDirectly(toolRegistry, options);
      return;
    }

    const model = registration ? registration.getModel() : getDeepSeekModel(options.modelId);
    const definition = formatAgentDefinition({
      id: "agent-core-cli",
      model,
      instructions: [
        "You are a terminal test harness for agent-core.",
        "Answer concisely in Chinese.",
        "Do not reveal API keys, hidden runtime state, or system configuration."
      ],
      toolNames: options.toolNames,
      resourceNames: options.resourceNames
    });

    const resolveApiKey = (provider: string) => {
      if (registration && provider === model.provider) return "faux-key";
      if (provider !== "deepseek") return undefined;
      return process.env.DEEPSEEK_API_KEY;
    };

    if (options.printResources) {
      const catalog = new ResourceCatalog(resourceRegistry);
      printResources(catalog, options);
      return;
    }

    if (options.printTools) {
      const catalog = new ToolCatalog(toolRegistry);
      printTools(catalog, options);
      return;
    }

    if (options.printSystemPrompt) {
      const assembly = new RuntimeAssembler({
        ...(resourceRegistry ? { resourceRegistry } : {}),
        ...(toolRegistry ? { toolRegistry } : {})
      }).assemble({
        sessionId: "agent-core-cli",
        definition,
        resolveApiKey
      });
      stdout.write(`${assembly.systemPrompt}\n`);
      return;
    }

    const runtime = new PiAgentRuntimeFactory({
      definition,
      ...(resourceRegistry ? { resourceRegistry } : {}),
      ...(toolRegistry ? { toolRegistry } : {}),
      ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
      resolveApiKey
    }).create("agent-core-cli");

    runtime.subscribe((event) => printEvent(event, options));
    const outcome = await runtime.execute({ type: "prompt", text: options.prompt });

    if (!options.json) stdout.write("\n");
    if (options.printState) {
      stdout.write(`${JSON.stringify(runtime.exportState())}\n`);
    }
    if (outcome.status === "failed") {
      stderr.write(`${outcome.errorCode}: ${outcome.message}\n`);
      process.exitCode = 1;
    }
  } finally {
    registration?.unregister();
  }
}

async function parseArgs(args: string[]): Promise<CliOptions> {
  const options: CliOptions = {
    json: false,
    faux: false,
    fauxResponse: "Faux runtime response.",
    exampleResources: false,
    exampleTools: false,
    modelId: process.env.DEEPSEEK_MODEL_ID ?? "deepseek-v4-flash",
    agentPlayground: false,
    approveToolCall: false,
    noToolPolicy: false,
    printResources: false,
    printState: false,
    printTools: false,
    printSystemPrompt: false,
    requestTimeoutMs: readOptionalPositiveInteger(process.env.AGENT_CORE_REQUEST_TIMEOUT_MS, "AGENT_CORE_REQUEST_TIMEOUT_MS"),
    resourceNames: [],
    toolArgs: {},
    toolCwd: resolve(process.env.INIT_CWD ?? process.cwd()),
    toolNames: [],
    prompt: ""
  };
  const promptParts: string[] = [];

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--faux") {
      options.faux = true;
      continue;
    }
    if (arg === "--example-tools") {
      options.exampleTools = true;
      continue;
    }
    if (arg === "--example-resources") {
      options.exampleResources = true;
      continue;
    }
    if (arg === "--faux-response") {
      options.fauxResponse = requireValue(args, ++index, "--faux-response");
      continue;
    }
    if (arg === "--model") {
      options.modelId = requireValue(args, ++index, "--model");
      continue;
    }
    if (arg === "--request-timeout-ms") {
      options.requestTimeoutMs = parsePositiveInteger(requireValue(args, ++index, "--request-timeout-ms"), "--request-timeout-ms");
      continue;
    }
    if (arg === "--agent-playground") {
      options.agentPlayground = true;
      continue;
    }
    if (arg === "--call-tool") {
      options.callTool = requireValue(args, ++index, "--call-tool");
      continue;
    }
    if (arg === "--tool-args") {
      options.toolArgs = parseJsonArg(requireValue(args, ++index, "--tool-args"), "--tool-args");
      continue;
    }
    if (arg === "--tool-cwd") {
      options.toolCwd = resolve(requireValue(args, ++index, "--tool-cwd"));
      continue;
    }
    if (arg === "--approve-tool-call" || arg === "--yes") {
      options.approveToolCall = true;
      continue;
    }
    if (arg === "--no-tool-policy") {
      options.noToolPolicy = true;
      continue;
    }
    if (arg === "--tools") {
      const value = requireValue(args, ++index, "--tools");
      options.toolNames = value.split(",").map((item) => item.trim()).filter(Boolean);
      continue;
    }
    if (arg === "--resources") {
      const value = requireValue(args, ++index, "--resources");
      options.resourceNames = value.split(",").map((item) => item.trim()).filter(Boolean);
      continue;
    }
    if (arg === "--print-system-prompt") {
      options.printSystemPrompt = true;
      continue;
    }
    if (arg === "--print-tools") {
      options.printTools = true;
      continue;
    }
    if (arg === "--print-resources") {
      options.printResources = true;
      continue;
    }
    if (arg === "--print-state") {
      options.printState = true;
      continue;
    }
    promptParts.push(arg);
  }

  options.prompt = promptParts.join(" ").trim();
  if (!options.prompt && !options.agentPlayground && !options.callTool && !options.printSystemPrompt && !options.printTools && !options.printResources && !stdin.isTTY) {
    options.prompt = await readStdin();
  }
  return options;
}

async function callToolDirectly(
  toolRegistry: ReturnType<typeof createAgentToolRegistry>,
  options: CliOptions,
) {
  const entry = toolRegistry.getEntry(options.callTool ?? "");
  if (!entry) {
    throw new Error(`Unknown tool "${options.callTool}". Available: ${toolRegistry.getAllEntries().map((item) => item.tool.name).join(", ")}`);
  }

  const runtime = createToolRuntime({
    ...(options.noToolPolicy ? {} : { policy: createDefaultToolPolicy() }),
    ...(options.approveToolCall ? { approvalHandler: () => true } : {}),
    onEvent: (event) => {
      if (options.json) {
        stderr.write(`${JSON.stringify(event)}\n`);
        return;
      }
      stderr.write(`[${event.type}] ${event.toolName}:${event.toolCallId}\n`);
    }
  });
  const result = await runtime.execute({
    tool: entry.tool,
    toolCallId: `cli:${entry.tool.name}`,
    args: options.toolArgs,
    context: {
      sessionId: "agent-core-cli",
      metadata: { cwd: options.toolCwd }
    }
  });

  if (options.json) {
    stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  stdout.write(`${readResultText(result.result)}\n`);
  if (result.status !== "succeeded") {
    stderr.write(`${result.error?.message ?? `Tool ${result.status}.`}\n`);
    process.exitCode = 1;
  }
}

function printResources(catalog: ResourceCatalog, options: CliOptions) {
  const resources = options.resourceNames.length > 0
    ? catalog.resolvePlan({ resourceNames: options.resourceNames }).resourceInfos
    : catalog.getAllResourceInfos();

  if (options.json) {
    stdout.write(`${JSON.stringify(resources)}\n`);
    return;
  }

  if (resources.length === 0) {
    stdout.write("No resources registered.\n");
    return;
  }

  for (const resource of resources) {
    stdout.write(`${resource.name} (${resource.sourceInfo.source}:${resource.sourceInfo.label})\n`);
    stdout.write(`  label: ${resource.label}\n`);
  }
}

function requireValue(args: string[], index: number, flag: string) {
  const value = args[index];
  if (!value) throw new Error(`${flag} requires a value.`);
  return value;
}

function parseJsonArg(value: string, flag: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${flag} must be valid JSON: ${message}`);
  }
}

function readOptionalPositiveInteger(value: string | undefined, label: string): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  return parsePositiveInteger(value, label);
}

function parsePositiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

function printEvent(event: AgentRuntimeEvent, options: CliOptions) {
  if (options.json) {
    stdout.write(`${JSON.stringify(event)}\n`);
    return;
  }

  if (event.type === "tool_started") {
    stderr.write(`\n[tool:${event.toolName}] started\n`);
    return;
  }
  if (event.type === "tool_finished") {
    stderr.write(`[tool:${event.toolCallId}] finished\n`);
    return;
  }
  if (event.type === "message_delta" && event.channel === "text") {
    stdout.write(event.delta);
    return;
  }
  if (event.type === "run_failed") {
    stderr.write(`\n${event.errorCode}: ${event.message}\n`);
  }
}

function printTools(catalog: ToolCatalog, options: CliOptions) {
  const tools = options.toolNames.length > 0
    ? catalog.resolvePlan({ toolNames: options.toolNames }).toolInfos
    : catalog.getAllToolInfos();

  if (options.json) {
    stdout.write(`${JSON.stringify(tools)}\n`);
    return;
  }

  if (tools.length === 0) {
    stdout.write("No tools registered.\n");
    return;
  }

  for (const tool of tools) {
    stdout.write(`${tool.name} (${tool.sourceInfo.source}:${tool.sourceInfo.label})\n`);
    stdout.write(`  label: ${tool.label}\n`);
    stdout.write(`  description: ${tool.description}\n`);
    if (tool.promptSnippet) stdout.write(`  promptSnippet: ${tool.promptSnippet}\n`);
    if (tool.promptGuidelines.length > 0) {
      stdout.write("  promptGuidelines:\n");
      for (const guideline of tool.promptGuidelines) {
        stdout.write(`    - ${guideline}\n`);
      }
    }
  }
}

function readResultText(result: unknown): string {
  if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content)) return "";
  return result.content.flatMap((block: unknown) => {
    if (!block || typeof block !== "object" || !("type" in block) || block.type !== "text") return [];
    return "text" in block && typeof block.text === "string" ? [block.text] : [];
  }).join("\n");
}

function readStdin() {
  return new Promise<string>((resolve, reject) => {
    let data = "";
    stdin.setEncoding("utf8");
    stdin.on("data", (chunk) => {
      data += chunk;
    });
    stdin.on("end", () => resolve(data.trim()));
    stdin.on("error", reject);
  });
}

function printUsage() {
  stdout.write(`Usage:
  npm run dev:core -- "你的问题"
  npm run dev:core -- --json "你的问题"
  npm run dev:core -- --faux "测试运行链路"
  npm run dev:core -- --example-tools --tools inspect_runtime,read_note --print-system-prompt
  npm run dev:core -- --example-tools --print-tools
  npm run dev:core -- --agent-playground
  npm run dev:core -- --call-tool read --tool-args '{"path":"package.json"}'
  npm run dev:core -- --example-resources --print-resources

Options:
  --json                    Output AgentRuntimeEvent as JSON lines.
  --faux                    Use a local faux provider instead of DeepSeek.
  --faux-response <text>    Response text for --faux mode.
  --agent-playground        Start an interactive AgentRuntime playground.
  --call-tool <name>        Execute a registered tool directly without calling the model.
  --tool-args <json>        JSON arguments for --call-tool. Defaults to {}.
  --tool-cwd <path>         Working directory for built-in ToolOperations. Defaults to process cwd.
  --approve-tool-call       Auto-approve policy approval requests in --call-tool mode.
  --no-tool-policy          Disable default ToolPolicy in --call-tool mode.
  --example-resources       Register CLI-only example resources for prompt assembly testing.
  --example-tools           Register CLI-only example tools for prompt assembly testing.
  --model <id>              DeepSeek model id. Defaults to DEEPSEEK_MODEL_ID from .env or.
  --request-timeout-ms <n>  Provider HTTP request timeout in milliseconds.
  --resources <a,b>         Enable host-registered resources by name.
  --tools <a,b>             Enable registered tools by name. Built-ins are registered by default: read,ls,grep,find,write,edit,bash.
  --print-resources         Print registered or selected resource metadata and exit without running the model.
  --print-tools             Print registered or selected tool metadata and exit without running the model.
  --print-system-prompt     Print the assembled system prompt and exit without running the model.
  --print-state             Print exported AgentConversationState JSON after running the prompt.

DeepSeek mode reads DEEPSEEK_API_KEY and optional DEEPSEEK_MODEL_ID from the nearest .env in the current directory or its parents.
`);
}

function loadDotEnv(filePath = findDotEnv()) {
  if (!filePath) return;
  if (!existsSync(filePath)) return;

  const content = readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const entry = parseDotEnvLine(line);
    if (!entry) continue;

    const [key, value] = entry;
    process.env[key] ??= value;
  }
}

function findDotEnv(startDirectory = process.cwd()): string | undefined {
  let directory = resolve(startDirectory);

  while (true) {
    const candidate = resolve(directory, ".env");
    if (existsSync(candidate)) return candidate;

    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function parseDotEnvLine(line: string): [string, string] | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return undefined;

  const normalized = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trimStart() : trimmed;
  const equalsIndex = normalized.indexOf("=");
  if (equalsIndex <= 0) return undefined;

  const key = normalized.slice(0, equalsIndex).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return undefined;

  const value = stripDotEnvQuotes(normalized.slice(equalsIndex + 1).trim());
  return [key, value];
}

function stripDotEnvQuotes(value: string) {
  if (value.length < 2) return value;

  const first = value.at(0);
  const last = value.at(-1);
  if ((first === "\"" && last === "\"") || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }
  return value;
}

function getDeepSeekModel(modelId: string): AgentModel {
  const models = getModels("deepseek");
  const model = models.find((candidate) => candidate.id === modelId);
  if (!model) {
    throw new Error(`Unknown DeepSeek model "${modelId}". Available: ${models.map((item) => item.id).join(", ")}`);
  }
  return model;
}

main().catch((error: unknown) => {
  stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
