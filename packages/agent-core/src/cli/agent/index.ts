#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { stderr, stdout } from "node:process";
import { pathToFileURL } from "node:url";
import { fauxAssistantMessage, fauxText, registerFauxProvider } from "@earendil-works/pi-ai";
import {
  createAgentResourceRegistry,
  createAgentToolRegistry,
  createBuiltInToolDefinitions,
  createLocalToolOperations,
  DEFAULT_DEEPSEEK_MODEL_ID,
  getDeepSeekModel,
} from "../../index.js";
import { startAgentPlayground, type AgentPlaygroundOptions } from "./main.js";
import { exampleCliResources } from "./resources/index.js";
import { exampleCliTools } from "./tools/index.js";

export { exampleCliResources, exampleCliTools, startAgentPlayground };
export type { AgentPlaygroundOptions };

type CliOptions = {
  json: boolean;
  faux: boolean;
  fauxResponses: string[];
  modelId: string;
  compactionSummarizer: "fallback" | "llm";
  requestTimeoutMs: number | undefined;
  resourceNames: string[];
  stateFile: string | undefined;
  toolCwd: string;
  toolNames: string[];
};

async function main() {
  loadDotEnv();
  const options = parseArgs(process.argv.slice(2));
  const registration = options.faux
    ? registerFauxProvider({ provider: "agent-core-cli-faux" })
    : undefined;

  if (registration) {
    registration.setResponses(options.fauxResponses.map((response) => fauxAssistantMessage(fauxText(response))));
  }

  try {
    const model = registration?.getModel() ?? getDeepSeekModel(options.modelId);
    const resourceRegistry = createAgentResourceRegistry(exampleCliResources);
    const toolOperations = createLocalToolOperations({ cwd: options.toolCwd });
    const toolRegistry = createAgentToolRegistry([
      ...createBuiltInToolDefinitions(toolOperations),
      ...exampleCliTools,
    ]);

    await startAgentPlayground({
      model,
      resolveApiKey: (provider) => {
        if (registration && provider === model.provider) return "faux-key";
        if (provider !== "deepseek") return undefined;
        return process.env.DEEPSEEK_API_KEY;
      },
      resourceRegistry,
      toolRegistry,
      workingDirectory: options.toolCwd,
      ...(options.toolNames.length > 0 ? { initialToolNames: options.toolNames } : {}),
      ...(options.resourceNames.length > 0 ? { initialResourceNames: options.resourceNames } : {}),
      initialCompactionSummarizer: options.compactionSummarizer,
      ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
      ...(options.stateFile === undefined ? {} : { stateFile: options.stateFile }),
      json: options.json,
    });
  } finally {
    registration?.unregister();
  }
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    json: false,
    faux: false,
    fauxResponses: [],
    modelId: process.env.DEEPSEEK_MODEL_ID ?? DEFAULT_DEEPSEEK_MODEL_ID,
    compactionSummarizer: "fallback",
    requestTimeoutMs: readOptionalPositiveInteger(process.env.AGENT_CORE_REQUEST_TIMEOUT_MS, "AGENT_CORE_REQUEST_TIMEOUT_MS"),
    resourceNames: [],
    stateFile: undefined,
    toolCwd: resolve(process.env.INIT_CWD ?? process.cwd()),
    toolNames: [],
  };

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
    if (arg === "--faux-response") {
      options.fauxResponses.push(requireValue(args, ++index, "--faux-response"));
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
    if (arg === "--playground-state-file") {
      options.stateFile = resolve(requireValue(args, ++index, "--playground-state-file"));
      continue;
    }
    if (arg === "--playground-compaction-summarizer") {
      options.compactionSummarizer = parseCompactionSummarizer(requireValue(args, ++index, "--playground-compaction-summarizer"));
      continue;
    }
    if (arg === "--tool-cwd") {
      options.toolCwd = resolve(requireValue(args, ++index, "--tool-cwd"));
      continue;
    }
    if (arg === "--tools") {
      options.toolNames = parseNameList(requireValue(args, ++index, "--tools"));
      continue;
    }
    if (arg === "--resources") {
      options.resourceNames = parseNameList(requireValue(args, ++index, "--resources"));
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  if (options.fauxResponses.length === 0) {
    options.fauxResponses.push("Faux runtime response.");
  }
  return options;
}

function parseCompactionSummarizer(value: string): "fallback" | "llm" {
  if (value === "fallback" || value === "llm") return value;
  throw new Error('--playground-compaction-summarizer expects "fallback" or "llm".');
}

function parseNameList(value: string) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function requireValue(args: string[], index: number, flag: string) {
  const value = args[index];
  if (!value) throw new Error(`${flag} requires a value.`);
  return value;
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

function printUsage() {
  stdout.write(`Usage:
  npm run dev:core
  npm run dev:core -- --faux
  npm run dev:core -- --tools read,ls,grep
  npm run dev:core -- --resources runtime_notes,prompt_rules

Options:
  --json                    Print playground runtime events as JSON lines.
  --faux                    Use a local faux provider instead of DeepSeek.
  --faux-response <text>    Response text for --faux mode.
  --model <id>              DeepSeek model id.
  --request-timeout-ms <n>  Provider HTTP request timeout in milliseconds.
  --tool-cwd <path>         Working directory for built-in tool operations.
  --tools <a,b>             Initial enabled tool names.
  --resources <a,b>         Initial enabled resource names.
  --playground-state-file <path>
                            Override the playground local state file.
  --playground-compaction-summarizer <fallback|llm>
                            Choose the initial compaction summarizer.
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

if (isDirectCliInvocation()) {
  main().catch((error: unknown) => {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

function isDirectCliInvocation() {
  const scriptPath = process.argv[1];
  return Boolean(scriptPath && pathToFileURL(resolve(scriptPath)).href === import.meta.url);
}
