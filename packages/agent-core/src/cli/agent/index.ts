#!/usr/bin/env node

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { stderr } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  AgentAppResourceLoader,
  createAgentResourceRegistry,
  createAgentToolRegistry,
  getDeepSeekModel,
} from "../../index.js";
import { startAgentPlayground, type AgentPlaygroundOptions } from "./main.js";

export { startAgentPlayground };
export type { AgentPlaygroundOptions };

async function main() {
  const agentDir = resolveAgentDir();
  const resourceLoader = new AgentAppResourceLoader({ agentDir });
  const resourceRegistry = createAgentResourceRegistry([]);
  const toolRegistry = createAgentToolRegistry([]);
  const model = getDeepSeekModel();

  await startAgentPlayground({
    model,
    resolveApiKey: (provider) => provider === "deepseek"
      ? process.env.DEEPSEEK_API_KEY
      : undefined,
    resourceLoader,
    resourceRegistry,
    toolRegistry,
    workingDirectory: process.cwd(),
  });
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

function resolveAgentDir() {
  const runtimeAgentDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = resolve(runtimeAgentDir, "../../..");
  const sourceAgentDir = resolve(packageRoot, "src/cli/agent");
  return existsSync(sourceAgentDir) ? sourceAgentDir : runtimeAgentDir;
}
