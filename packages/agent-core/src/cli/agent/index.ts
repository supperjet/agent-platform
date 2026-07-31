#!/usr/bin/env node

import { config } from "dotenv";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { stderr } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startAgentPlayground } from "./main.js";
import {
  ResourceLoader,
  ToolsLoader,
  getDeepSeekModel,
} from "../../index.js";
import type { AgentPlaygroundOptions } from "./main.js";

config({ path: new URL("../../../../../.env", import.meta.url), quiet: true });

export { startAgentPlayground };
export type { AgentPlaygroundOptions };

async function main() {
  // 解析 agent 应用目录
  const agentDir = resolveAgentDir();
  const resourceRegistry = new ResourceLoader({ agentDir }).createRegistry();
  const toolRegistry = await new ToolsLoader({ agentDir }).createRegistry();
  // 获取模型
  const model = getDeepSeekModel();

  await startAgentPlayground({
    model,
    resourceRegistry,
    toolRegistry,
    workingDirectory: process.cwd(),
    resolveApiKey: (provider) => provider === "deepseek"
      ? process.env.DEEPSEEK_API_KEY
      : undefined,
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
