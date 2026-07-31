import type { AgentModel } from "../../contracts.js";
import {
  createAgentResourceRegistry,
  createAgentToolRegistry,
  createBuiltInToolDefinitions,
  createLocalToolOperations,
  DEFAULT_DEEPSEEK_MODEL_ID,
  getDeepSeekModel,
} from "../../index.js";
import type { AgentResourceDefinition } from "../../resources/resource-catalog.js";
import type { AnyAgentToolDefinition } from "../../tools/tool-registry.js";
import { startAgentPlayground, type AgentPlaygroundOptions } from "./main.js";
import { exampleCliResources } from "./resources/index.js";
import { exampleCliTools } from "./tools/index.js";

export { exampleCliResources, exampleCliTools, startAgentPlayground };
export type { AgentPlaygroundOptions };

export const CLI_AGENT_DEFAULT_TOOL_NAMES = ["read", "ls", "grep", "find", "write", "edit", "bash"] as const;

export type CliAgentModelOptions = {
  fauxModel?: AgentModel;
  modelId?: string;
};

export type CliAgentToolRegistryOptions = {
  cwd: string;
  extraTools?: readonly AnyAgentToolDefinition[];
};

export type CliAgentResourceRegistryOptions = {
  extraResources?: readonly AgentResourceDefinition[];
};

export type StartCliAgentPlaygroundOptions = Omit<
  AgentPlaygroundOptions,
  "model" | "resolveApiKey" | "resources" | "tools"
> & {
  fauxModel?: AgentModel;
  modelId?: string;
  resolveApiKey?: AgentPlaygroundOptions["resolveApiKey"];
};

/**
 * CLI agent 应用入口的模型加载约定。
 *
 * fauxModel 用于本地测试；没有 fauxModel 时才读取真实 DeepSeek 模型配置。
 */
export function loadCliAgentModel(options: CliAgentModelOptions = {}) {
  return options.fauxModel ?? getDeepSeekModel(options.modelId ?? DEFAULT_DEEPSEEK_MODEL_ID);
}

/**
 * CLI agent 应用入口的资源发现约定。
 *
 * 目前先加载 agent/resources/index.ts 中声明的资源，后续 ResourceLoader
 * 会在这里接入文件夹扫描，把 MEMORY.md、AGENTS.md 等文本资源纳入统一计划。
 */
export function createCliAgentResourceRegistry(options: CliAgentResourceRegistryOptions = {}) {
  return createAgentResourceRegistry([
    ...exampleCliResources,
    ...(options.extraResources ?? []),
  ]);
}

/**
 * CLI agent 应用入口的工具发现约定。
 *
 * 工具可以被发现和注册，但仍然留在 ToolCatalog/ToolRuntime 边界内，
 * 不作为 ResourceLoader 的文本资源处理。
 */
export function createCliAgentToolRegistry(options: CliAgentToolRegistryOptions) {
  const toolOperations = createLocalToolOperations({ cwd: options.cwd });
  return createAgentToolRegistry([
    ...createBuiltInToolDefinitions(toolOperations),
    ...exampleCliTools,
    ...(options.extraTools ?? []),
  ]);
}

export function createCliAgentApiKeyResolver(
  model: AgentModel,
  fauxProvider?: string,
): AgentPlaygroundOptions["resolveApiKey"] {
  return (provider) => {
    if (fauxProvider && provider === model.provider) return "faux-key";
    if (provider !== "deepseek") return undefined;
    return process.env.DEEPSEEK_API_KEY;
  };
}

export async function startCliAgentPlayground({
  fauxModel,
  modelId,
  resolveApiKey,
  ...options
}: StartCliAgentPlaygroundOptions) {
  const model = loadCliAgentModel({
    ...(fauxModel ? { fauxModel } : {}),
    ...(modelId ? { modelId } : {}),
  });
  await startAgentPlayground({
    ...options,
    model,
    resolveApiKey: resolveApiKey ?? createCliAgentApiKeyResolver(model, fauxModel?.provider),
    resources: exampleCliResources,
    tools: exampleCliTools,
  });
}
