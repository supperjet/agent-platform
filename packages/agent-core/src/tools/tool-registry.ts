import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "@earendil-works/pi-ai";
import type { AgentToolName } from "../definition/agent-definition.js";

// ---------------------------------------------------------------------------
// 工具元数据
// ---------------------------------------------------------------------------

/**
 * 描述工具定义的来源。
 *
 * 这类信息只用于诊断、目录展示和调试 UI/API 返回值；底层 Pi Agent
 * 执行工具时不依赖这些字段。
 */
export type AgentToolSourceInfo = {
  source: "builtin" | "registry" | "sdk" | "extension";
  label: string;
};

/**
 * agent-core 在工具定义上附加的编排层元数据。
 *
 * Pi Agent 真正执行时只需要 `name`、`description`、`parameters` 和 `execute`。
 * 这里保留额外字段，是为了让 `ToolCatalog` 和 `PromptAssembler` 不需要窥探
 * execute 闭包，也能向模型、调用方或调试界面解释工具能力。
 */
export type AgentToolMetadata = {
  /** 用于 system prompt 的一句话能力摘要，通常比 description 更短、更面向模型提示。 */
  promptSnippet: string;
  /** 仅当该工具启用时注入 prompt 的额外使用约束或建议。 */
  promptGuidelines: readonly string[];
  /** 工具来源信息，用于目录和调试；运行时执行不需要它。 */
  sourceInfo: AgentToolSourceInfo;
};

// ---------------------------------------------------------------------------
// 工具定义形态
// ---------------------------------------------------------------------------

/**
 * 编写具体工具时使用的强类型定义。
 *
 * `TParams` 让 TypeBox 参数 schema 与工具的 `execute` 参数签名保持关联。
 * 内置工具通常通过 `defineAgentTool(...)` 以这个形态声明自己。
 */
export type AgentToolDefinition<TParams extends TSchema = TSchema, TDetails = any> =
  AgentTool<TParams, TDetails> & AgentToolMetadata;

/**
 * 注册表和目录层使用的类型擦除工具定义。
 *
 * 一个 registry 会把参数 schema 不同的工具放进同一个 Map。到了这个边界，
 * 我们刻意擦除每个工具自己的泛型参数/详情类型，只保留共同的运行时结构和元数据。
 */
export type AnyAgentToolDefinition = Omit<AgentTool, "execute" | "prepareArguments"> & AgentToolMetadata & {
  prepareArguments?: (args: unknown) => unknown;
  execute: (...args: any[]) => any;
};

// ---------------------------------------------------------------------------
// 注册表条目与公开契约
// ---------------------------------------------------------------------------

/**
 * registry 内部保存的完整条目。
 *
 * 同时保留两份视图：
 * - `definition`：面向 harness 的完整定义，包含 prompt/debug 元数据。
 * - `tool`：面向 Pi Agent 执行循环的运行时工具，已经剥离编排层元数据。
 */
export type AgentToolRegistryEntry = {
  definition: AnyAgentToolDefinition;
  sourceInfo: AgentToolSourceInfo;
  tool: AgentTool;
};

/**
 * 按工具名寻址的可用工具集合。
 *
 * registry 不决定某个 agent 应该启用哪些工具；它只保存“已经装配进来”的工具，
 * 并按名字解析请求。内置工具是否注册由调用方手动选择；面向 prompt 的投影放在
 * `tool-catalog.ts`；执行前后的 hook 以后应放到 `ToolRuntime` 一类的层里。
 */
export type AgentToolRegistry = {
  /** 将工具名直接解析为 agent loop 可执行的运行时工具。 */
  resolve(names: readonly AgentToolName[]): readonly AgentTool[];
  /** 将工具名解析为完整 registry 条目，保留 prompt/debug 元数据。 */
  resolveEntries(names: readonly AgentToolName[]): readonly AgentToolRegistryEntry[];
  /** 按注册顺序返回所有条目。 */
  getAllEntries(): readonly AgentToolRegistryEntry[];
  /** 按精确名称返回一个完整条目；未注册时返回 undefined。 */
  getEntry(name: AgentToolName): AgentToolRegistryEntry | undefined;
  /** 按精确名称返回一个完整定义；未注册时返回 undefined。 */
  getDefinition(name: AgentToolName): AnyAgentToolDefinition | undefined;
};

// ---------------------------------------------------------------------------
// 定义辅助函数
// ---------------------------------------------------------------------------

/**
 * 保留具体工具泛型推断的 identity helper。
 *
 * 没有这个 helper 时，TypeScript 经常会过早把工具定义拓宽成宽泛类型。
 * 通过它，内置工具或 SDK 工具可以在定义处保留精确参数类型，同时仍能交给
 * 类型擦除后的 registry 保存。
 */
export function defineAgentTool<TParams extends TSchema, TDetails = any>(
  definition: AgentToolDefinition<TParams, TDetails>
): AgentToolDefinition<TParams, TDetails> {
  return definition;
}

// ---------------------------------------------------------------------------
// 注册表构造
// ---------------------------------------------------------------------------

/**
 * 根据具体工具或 SDK 工具定义创建 registry。
 *
 * 这里的校验刻意保持很薄，只做结构性检查：
 * - 工具名不能为空。
 * - 工具名不能重复。
 *
 * 更深的策略判断，比如某个运行时是否允许 `bash`，应该在 registry 之上通过
 * “手动选择注册哪些内置工具定义”来完成。
 */
export function createAgentToolRegistry(tools: readonly AnyAgentToolDefinition[]): AgentToolRegistry {
  const entriesByName = new Map<string, AgentToolRegistryEntry>();

  for (const tool of tools) {
    assertNonBlank("AgentToolRegistry.tools[].name", tool.name);
    if (entriesByName.has(tool.name)) {
      throw new Error(`AgentToolRegistry contains duplicate tool name: ${tool.name}`);
    }
    entriesByName.set(tool.name, createRegistryEntry(tool));
  }

  return {
    resolve(names) {
      return resolveEntries(entriesByName, names).map((entry) => entry.tool);
    },
    resolveEntries(names) {
      return resolveEntries(entriesByName, names);
    },
    getAllEntries() {
      return [...entriesByName.values()];
    },
    getEntry(name) {
      return entriesByName.get(name);
    },
    getDefinition(name) {
      return entriesByName.get(name)?.definition;
    }
  };
}

/**
 * 默认装配路径使用的空 registry。
 *
 * 如果调用方需要内置工具，应从 `tools/built-in/` 手动组合工具定义，
 * 再传入 `createAgentToolRegistry(...)`。
 */
export function createDefaultAgentToolRegistry(): AgentToolRegistry {
  return createAgentToolRegistry([]);
}

// ---------------------------------------------------------------------------
// 运行时投影
// ---------------------------------------------------------------------------

/**
 * 将 harness 工具定义转换为底层 Pi Agent 可执行的工具形态。
 *
 * 这里会刻意剥离 prompt/debug 元数据。模型看到的工具摘要和使用准则来自
 * `PromptAssembler`，而不是可执行工具对象本身。
 */
export function wrapAgentToolDefinition(definition: AnyAgentToolDefinition): AgentTool {
  return {
    name: definition.name,
    label: definition.label,
    description: definition.description,
    parameters: definition.parameters,
    ...(definition.prepareArguments ? { prepareArguments: definition.prepareArguments } : {}),
    ...(definition.executionMode ? { executionMode: definition.executionMode } : {}),
    execute: definition.execute as AgentTool["execute"]
  };
}

// ---------------------------------------------------------------------------
// 本地辅助函数
// ---------------------------------------------------------------------------

function assertNonBlank(field: string, value: string) {
  if (value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
}

/**
 * 构造 registry 保存的“双视图”条目。
 */
function createRegistryEntry(definition: AnyAgentToolDefinition): AgentToolRegistryEntry {
  return {
    definition,
    sourceInfo: definition.sourceInfo,
    tool: wrapAgentToolDefinition(definition)
  };
}

/**
 * 按请求顺序解析工具名；如果工具不存在，立即抛出清晰错误。
 */
function resolveEntries(
  entriesByName: ReadonlyMap<string, AgentToolRegistryEntry>,
  names: readonly AgentToolName[]
): readonly AgentToolRegistryEntry[] {
  return names.map((name) => {
    assertNonBlank("AgentDefinition.toolNames[]", name);
    const entry = entriesByName.get(name);
    if (!entry) {
      throw new Error(`AgentToolRegistry does not contain tool: ${name}`);
    }
    return entry;
  });
}
