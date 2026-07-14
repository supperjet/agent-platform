import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AgentToolName } from "../definition/agent-definition.js";
import type { ResolvedAgentDefinition } from "../definition/definition-resolver.js";
import {
  createDefaultAgentToolRegistry,
  type AgentToolRegistry,
  type AgentToolSourceInfo
} from "./tool-registry.js";

// ---------------------------------------------------------------------------
// Catalog 投影类型
// ---------------------------------------------------------------------------

/**
 * runtime 装配过程中使用的完整活动工具条目。
 *
 * 这是 `AgentToolRegistry` 和 harness 其他模块之间的桥接形态。它既保留给
 * agent loop 调用的可执行 `tool`，也保留 `PromptAssembler`、诊断和 UI
 * 所需要的 prompt/debug 元数据。
 */
export type ToolCatalogEntry = {
  name: AgentToolName;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines: readonly string[];
  sourceInfo: AgentToolSourceInfo;
  tool: AgentTool;
};

/**
 * 面向公开 API 或调试界面的安全工具视图。
 *
 * 与 `ToolCatalogEntry` 不同，这个结构刻意不暴露 execute 函数，因此可以安全
 * 返回给调用方或展示在调试界面里，不会泄漏实现闭包。
 */
export type ToolCatalogToolInfo = {
  name: AgentToolName;
  label: string;
  description: string;
  parameters: AgentTool["parameters"];
  promptSnippet?: string;
  promptGuidelines: readonly string[];
  sourceInfo: AgentToolSourceInfo;
};

/**
 * 解析一次“请求启用的工具集合”后得到的完整结果。
 *
 * 不同消费者需要不同投影：
 * - `tools`：给 agent loop 使用的运行时对象。
 * - `entries`：内部装配使用的完整记录。
 * - `toolInfos`：给 API/debug 使用的安全记录。
 */
export type ToolCatalogResolution = {
  toolNames: readonly AgentToolName[];
  entries: readonly ToolCatalogEntry[];
  toolInfos: readonly ToolCatalogToolInfo[];
  tools: readonly AgentTool[];
};

// ---------------------------------------------------------------------------
// 启用策略扩展点
// ---------------------------------------------------------------------------

/**
 * 传给 catalog 层启用规则的输入。
 *
 * catalog 可以在某个工具真正成为 agent 的活动工具前做最后拦截。这个边界比
 * registry 构造更窄：调用方先决定哪些内置工具定义进入 registry，而启用规则
 * 只负责针对某个 agent definition 做最终检查。
 */
export type ToolEnablementInput = {
  definition?: ResolvedAgentDefinition;
  toolName: AgentToolName;
  tool: AgentTool;
};

/**
 * 启用规则的返回值。
 *
 * 简单场景可以直接返回 boolean；对象形式可以携带可读的拒绝原因，
 * 并拼进最终抛出的错误里。
 */
export type ToolEnablementDecision =
  | boolean
  | {
      enabled: boolean;
      reason?: string;
    };

/**
 * `ToolCatalog` 在解析活动工具时调用的启用判断函数。
 */
export type ToolEnablementRule = (input: ToolEnablementInput) => ToolEnablementDecision;

// ---------------------------------------------------------------------------
// 工具目录
// ---------------------------------------------------------------------------

/**
 * 将 agent 请求的工具名解析成运行时对象和 prompt/API 安全投影。
 *
 * 职责边界：
 * - `ToolRegistry`：按名称保存所有可用工具定义。
 * - `ToolCatalog`：解析某个 agent 的活动工具名，规范化元数据，执行启用规则，
 *   并返回 runtime/prompt/UI 所需的不同投影。
 * - `ToolRuntime`（未来）：处理工具执行前后的 hook、观测和控制。
 */
export class ToolCatalog {
  constructor(
    private readonly registry: AgentToolRegistry = createDefaultAgentToolRegistry(),
    private readonly enablementRules: readonly ToolEnablementRule[] = []
  ) {}

  /**
   * 给只需要运行时工具对象的调用方使用的便捷入口。
   */
  resolve(names: readonly AgentToolName[]): readonly AgentTool[] {
    return this.resolvePlan({ toolNames: names }).tools;
  }

  /**
   * 解析完整 agent definition 中声明的工具名。
   */
  resolveForDefinition(definition: ResolvedAgentDefinition): ToolCatalogResolution {
    return this.resolvePlan({
      definition,
      toolNames: definition.toolNames
    });
  }

  /**
   * 将 registry 中的每个工具都规范化为 catalog 条目返回。
   *
   * 这个方法主要用于诊断和工具化场景；返回全部工具不代表它们都会被某个 agent 启用。
   */
  getAllTools(): readonly ToolCatalogEntry[] {
    return this.registry.getAllEntries().map((entry) => createCatalogEntry(entry.definition.name, entry));
  }

  /**
   * 以安全的 debug/API 视图返回 registry 中的所有工具。
   */
  getAllToolInfos(): readonly ToolCatalogToolInfo[] {
    return this.getAllTools().map(toToolInfo);
  }

  /**
   * 查找一个已注册工具，并规范化为完整 catalog 条目。
   */
  getToolDefinition(name: AgentToolName): ToolCatalogEntry | undefined {
    const normalizedName = normalizeSingleToolName("ToolCatalog.toolName", name);
    const entry = this.registry.getEntry(normalizedName);
    if (!entry) return undefined;
    return createCatalogEntry(normalizedName, entry);
  }

  /**
   * 查找一个已注册工具，并返回安全的 debug/API 视图。
   */
  getToolInfo(name: AgentToolName): ToolCatalogToolInfo | undefined {
    const entry = this.getToolDefinition(name);
    if (!entry) return undefined;
    return toToolInfo(entry);
  }

  /**
   * 解析并校验一次请求启用的工具集合。
   *
   * 这是主要装配路径：保留请求顺序，在 registry 查找前拒绝重复名称，确认 registry
   * 没有返回名称不匹配的工具，执行启用规则，然后返回下游模块需要的全部投影。
   */
  resolvePlan(input: {
    definition?: ResolvedAgentDefinition;
    toolNames: readonly AgentToolName[];
  }): ToolCatalogResolution {
    const toolNames = normalizeToolNames(input.toolNames);
    const registryEntries = this.registry.resolveEntries(toolNames);
    const entries = registryEntries.map((entry, index) => {
      const toolName = toolNames[index];
      if (!toolName) {
        throw new Error(`ToolCatalog resolved unexpected tool at index: ${index}`);
      }
      const { definition, tool } = entry;
      assertToolNameMatchesRequest(toolName, tool);
      assertToolEnabled({
        ...(input.definition ? { definition: input.definition } : {}),
        toolName,
        tool
      }, this.enablementRules);
      return createCatalogEntry(toolName, entry);
    });

    return {
      toolNames,
      entries,
      toolInfos: entries.map(toToolInfo),
      tools: entries.map((entry) => entry.tool)
    };
  }
}

// ---------------------------------------------------------------------------
// 投影辅助函数
// ---------------------------------------------------------------------------

/**
 * 将一个 registry 条目规范化为更完整的 catalog 条目。
 */
function createCatalogEntry(toolName: AgentToolName, entry: {
  definition: {
    name: AgentToolName;
    label: string;
    description: string;
    promptSnippet?: string;
    promptGuidelines?: readonly string[];
  };
  sourceInfo: AgentToolSourceInfo;
  tool: AgentTool;
}): ToolCatalogEntry {
  const { definition } = entry;
  const promptSnippet = normalizeOptionalToolText(
    `AgentTool.${toolName}.promptSnippet`,
    definition.promptSnippet
  );
  return {
    name: normalizeSingleToolName(`AgentTool.${toolName}.name`, definition.name),
    label: normalizeToolText(`AgentTool.${toolName}.label`, definition.label),
    description: normalizeToolText(`AgentTool.${toolName}.description`, definition.description),
    ...(promptSnippet ? { promptSnippet } : {}),
    promptGuidelines: normalizePromptGuidelines(toolName, definition.promptGuidelines),
    sourceInfo: entry.sourceInfo,
    tool: entry.tool
  };
}

/**
 * 从完整 catalog 条目中移除可执行运行时细节。
 */
function toToolInfo(entry: ToolCatalogEntry): ToolCatalogToolInfo {
  return {
    name: entry.name,
    label: entry.label,
    description: entry.description,
    parameters: entry.tool.parameters,
    ...(entry.promptSnippet ? { promptSnippet: entry.promptSnippet } : {}),
    promptGuidelines: entry.promptGuidelines,
    sourceInfo: entry.sourceInfo
  };
}

// ---------------------------------------------------------------------------
// 规范化与校验
// ---------------------------------------------------------------------------

/**
 * 规范化请求的工具名，并拒绝重复启用同一个工具。
 */
function normalizeToolNames(names: readonly AgentToolName[]): readonly AgentToolName[] {
  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const name of names) {
    const normalizedName = normalizeSingleToolName("ToolCatalog.toolNames[]", name);
    if (seen.has(normalizedName)) {
      throw new Error(`ToolCatalog.toolNames contains duplicate tool name: ${normalizedName}`);
    }
    seen.add(normalizedName);
    normalized.push(normalizedName);
  }

  return normalized;
}

/**
 * 规范化单个工具名字段。
 */
function normalizeSingleToolName(field: string, name: AgentToolName): AgentToolName {
  assertNonBlank(field, name);
  return name.trim();
}

/**
 * 防御有缺陷或自定义 registry 将请求名解析到错误工具名。
 */
function assertToolNameMatchesRequest(requestedName: string, tool: AgentTool) {
  assertNonBlank(`AgentTool.${requestedName}.name`, tool.name);
  if (tool.name !== requestedName) {
    throw new Error(`ToolCatalog resolved ${requestedName} to mismatched tool: ${tool.name}`);
  }
}

/**
 * 执行所有 catalog 层启用规则。
 */
function assertToolEnabled(input: ToolEnablementInput, rules: readonly ToolEnablementRule[]) {
  for (const rule of rules) {
    const decision = normalizeEnablementDecision(rule(input));
    if (!decision.enabled) {
      const reason = decision.reason ? `: ${decision.reason}` : "";
      throw new Error(`ToolCatalog tool is disabled: ${input.toolName}${reason}`);
    }
  }
}

/**
 * 将 boolean 简写转换为错误处理使用的对象形式。
 */
function normalizeEnablementDecision(decision: ToolEnablementDecision): { enabled: boolean; reason?: string } {
  if (typeof decision === "boolean") return { enabled: decision };
  return decision;
}

/**
 * 规范化必填的人类可读元数据。
 */
function normalizeToolText(field: string, value: string) {
  assertNonBlank(field, value);
  return value.trim();
}

/**
 * 规范化可选的 prompt 文本。
 *
 * 摘要会被嵌入紧凑的 prompt 工具说明里，因此这里会折叠换行，
 * 让它保持为单行能力描述。
 */
function normalizeOptionalToolText(field: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  assertNonBlank(field, value);
  return value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * 规范化并去重单个工具的 prompt 使用准则，同时保留原始顺序。
 */
function normalizePromptGuidelines(toolName: string, guidelines: readonly string[] | undefined): readonly string[] {
  if (!guidelines) return [];
  const normalized = new Set<string>();
  for (const guideline of guidelines) {
    const value = normalizeOptionalToolText(`AgentTool.${toolName}.promptGuidelines[]`, guideline);
    if (value) normalized.add(value);
  }
  return [...normalized];
}

/**
 * catalog 字段共用的非空字符串断言。
 */
function assertNonBlank(field: string, value: string) {
  if (value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
}
