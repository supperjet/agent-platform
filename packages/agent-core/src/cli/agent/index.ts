#!/usr/bin/env node

import { resolve } from "node:path";
import { stderr } from "node:process";
import { pathToFileURL } from "node:url";
import {
  createAgentResourceRegistry,
  createAgentToolRegistry,
  getDeepSeekModel,
} from "../../index.js";
import { startAgentPlayground, type AgentPlaygroundOptions } from "./main.js";
import { exampleCliResources } from "./resources/index.js";

export { exampleCliResources, startAgentPlayground };
export type { AgentPlaygroundOptions };

async function main() {
  const resourceRegistry = createAgentResourceRegistry(exampleCliResources);
  const toolRegistry = createAgentToolRegistry([]);
  const model = getDeepSeekModel();

  await startAgentPlayground({
    model,
    resolveApiKey: (provider) => provider === "deepseek"
      ? process.env.DEEPSEEK_API_KEY
      : undefined,
    resourceRegistry,
    toolRegistry,
    workingDirectory: process.cwd(),
    initialToolNames: [],
    initialResourceNames: exampleCliResources.map((resource) => resource.name),
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
