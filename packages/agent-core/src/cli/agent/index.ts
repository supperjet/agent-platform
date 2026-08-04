#!/usr/bin/env node

import { config } from "dotenv";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { stderr } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startAgentPlayground } from "./main.js";
import {
  ResourceLoader,
  PromptTemplateLoader,
  createSkillRegistry,
  SkillLoader,
  type SkillDiagnostic,
  ToolsLoader,
  getDeepSeekModel,
} from "../../index.js";

config({ path: new URL("../../../../../.env", import.meta.url), quiet: true });

async function main() {
  // 解析 agent 应用目录
  const agentDir = resolveAgentDir();
  const workingDirectory = process.cwd();
  const resourceRegistry = new ResourceLoader({ agentDir }).createRegistry();
  const promptTemplateRegistry = new PromptTemplateLoader({ agentDir }).createRegistry();
  const skillSnapshot = new SkillLoader({ agentDir }).load();
  if (skillSnapshot.diagnostics.length) {
    stderr.write(formatSkillDiagnosticsForStderr(skillSnapshot.diagnostics));
  }
  const skillError = skillSnapshot.diagnostics.find((diagnostic) => diagnostic.type === "error");
  if (skillError) {
    throw new Error(`SkillLoader failed: ${skillError.message}`);
  }
  const skillRegistry = createSkillRegistry(skillSnapshot.skills);
  const toolRegistry = await new ToolsLoader({ agentDir, workingDirectory }).createRegistry();
  // 获取模型
  const model = getDeepSeekModel();

  await startAgentPlayground({
    model,
    resourceRegistry,
    promptTemplateRegistry,
    skillRegistry,
    skillDiagnostics: skillSnapshot.diagnostics,
    toolRegistry,
    workingDirectory,
    resolveApiKey: (provider) => provider === "deepseek"
      ? process.env.DEEPSEEK_API_KEY
      : undefined,
  });
}

function formatSkillDiagnosticsForStderr(diagnostics: readonly SkillDiagnostic[]) {
  return [
    "SkillLoader diagnostics:",
    ...diagnostics.map((diagnostic) => [
      `- ${diagnostic.type}: ${diagnostic.code}: ${diagnostic.message}`,
      ...(diagnostic.path ? [`  path: ${diagnostic.path}`] : []),
    ].join("\n")),
    "",
  ].join("\n");
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
