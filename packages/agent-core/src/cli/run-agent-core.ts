#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { stdin, stderr, stdout } from "node:process";
import { fauxAssistantMessage, fauxText, registerFauxProvider } from "@earendil-works/pi-ai";
import {
  DEFAULT_DEEPSEEK_MODEL_ID,
  createAgentResourceRegistry,
  createAgentToolRegistry,
  formatAgentDefinition,
  getDeepSeekModel,
  PiAgentRuntimeFactory,
  type AgentRuntimeEvent
} from "../index.js";
import { ResourceCatalog } from "../resources/resource-catalog.js";
import { RuntimeAssembler } from "../runtime/runtime-assembler.js";
import { ToolCatalog } from "../tools/tool-catalog.js";
import { exampleCliResources } from "./example-resources.js";
import { exampleCliTools } from "./example-tools.js";

type CliOptions = {
  json: boolean;
  faux: boolean;
  fauxResponse: string;
  exampleResources: boolean;
  exampleTools: boolean;
  modelId: string;
  printResources: boolean;
  printState: boolean;
  printTools: boolean;
  printSystemPrompt: boolean;
  resourceNames: string[];
  toolNames: string[];
  prompt: string;
};

async function main() {
  loadDotEnv();
  const options = await parseArgs(process.argv.slice(2));
  if (!options.prompt.trim() && !options.printSystemPrompt && !options.printTools && !options.printResources) {
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
    const resourceRegistry = options.exampleResources
      ? createAgentResourceRegistry(exampleCliResources)
      : undefined;
    const toolRegistry = options.exampleTools ? createAgentToolRegistry(exampleCliTools) : undefined;
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
    modelId: process.env.DEEPSEEK_MODEL_ID ?? DEFAULT_DEEPSEEK_MODEL_ID,
    printResources: false,
    printState: false,
    printTools: false,
    printSystemPrompt: false,
    resourceNames: [],
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
  if (!options.prompt && !options.printSystemPrompt && !options.printTools && !options.printResources && !stdin.isTTY) {
    options.prompt = await readStdin();
  }
  return options;
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
  npm run dev:core -- --example-resources --print-resources

Options:
  --json                    Output AgentRuntimeEvent as JSON lines.
  --faux                    Use a local faux provider instead of DeepSeek.
  --faux-response <text>    Response text for --faux mode.
  --example-resources       Register CLI-only example resources for prompt assembly testing.
  --example-tools           Register CLI-only example tools for prompt assembly testing.
  --model <id>              DeepSeek model id. Defaults to DEEPSEEK_MODEL_ID from .env or ${DEFAULT_DEEPSEEK_MODEL_ID}.
  --resources <a,b>         Enable host-registered resources by name.
  --tools <a,b>             Enable host-registered tools by name.
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

main().catch((error: unknown) => {
  stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
