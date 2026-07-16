import {
  allowTool,
  blockTool,
  requireToolApproval,
  type ToolApprovalRequest,
  type ToolPolicy,
} from "./tool-policy.js";

// ---------------------------------------------------------------------------
// 默认策略配置
// ---------------------------------------------------------------------------

/** 默认需要宿主确认的高风险内置工具。 */
const DEFAULT_APPROVAL_REQUIRED_TOOLS = ["write", "edit", "bash"];

/** 默认禁止访问的敏感路径片段。 */
const DEFAULT_DENIED_PATH_PATTERNS = [
  /(^|\/)\.env($|\.)/,
  /(^|\/)\.ssh(\/|$)/,
  /(^|\/)\.aws(\/|$)/,
  /(^|\/)\.config\/gh(\/|$)/,
];

/** 默认禁止执行的高破坏性 shell 命令。 */
const DEFAULT_DENIED_BASH_PATTERNS = [
  /\brm\s+-[^;\n]*r[^;\n]*f\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-[^;\n]*f\b/,
  /\bchmod\s+-R\s+777\b/,
];

/**
 * 内置默认 ToolPolicy 的配置。
 *
 * 第一版只做静态规则，不推断复杂 shell 语义；真正的路径根限制仍交给
 * ToolOperations，policy 负责更高层的安全/approval 决策。
 */
export type DefaultToolPolicyOptions = {
  /** 明确拒绝的工具名，优先级最高。 */
  deniedTools?: readonly string[];
  /** 需要宿主确认的工具名。默认 write/edit/bash。 */
  approvalRequiredTools?: readonly string[];
  /** 禁止访问的路径正则，匹配 read/write/edit/ls/grep/find 的 path。 */
  deniedPathPatterns?: readonly RegExp[];
  /** 禁止执行的 bash command 正则。 */
  deniedBashPatterns?: readonly RegExp[];
  /** 是否拒绝未显式出现在任一规则里的工具。默认 false。 */
  denyUnknownTools?: boolean;
};

/**
 * 创建 agent-core 默认工具策略。
 *
 * 默认行为：
 * - read / ls / grep / find：允许，除非命中敏感路径。
 * - write / edit / bash：需要 approval，除非命中禁止规则则直接 block。
 * - unknown tool：默认允许，便于 SDK/extension 工具接入。
 */
export function createDefaultToolPolicy(options: DefaultToolPolicyOptions = {}): ToolPolicy {
  const deniedTools = new Set(options.deniedTools ?? []);
  const approvalRequiredTools = new Set(options.approvalRequiredTools ?? DEFAULT_APPROVAL_REQUIRED_TOOLS);
  const deniedPathPatterns = options.deniedPathPatterns ?? DEFAULT_DENIED_PATH_PATTERNS;
  const deniedBashPatterns = options.deniedBashPatterns ?? DEFAULT_DENIED_BASH_PATTERNS;

  return {
    decide(input) {
      if (deniedTools.has(input.toolName)) {
        return blockTool(`Tool "${input.toolName}" is denied by policy.`, "tool_denied");
      }

      const path = readPathArg(input.args);
      if (path && deniedPathPatterns.some((pattern) => pattern.test(path))) {
        return blockTool(`Path "${path}" is denied by policy.`, "path_denied");
      }

      if (input.toolName === "bash") {
        const command = readCommandArg(input.args);
        if (command && deniedBashPatterns.some((pattern) => pattern.test(command))) {
          return blockTool(`Command "${command}" is denied by policy.`, "command_denied");
        }
      }

      if (approvalRequiredTools.has(input.toolName)) {
        return requireToolApproval(
          `Tool "${input.toolName}" requires approval.`,
          createApprovalRequest(input.toolName, input.args),
        );
      }

      if (options.denyUnknownTools && !isKnownBuiltInTool(input.toolName)) {
        return blockTool(`Tool "${input.toolName}" is not explicitly allowed.`, "tool_unknown");
      }

      return allowTool();
    },
  };
}

function createApprovalRequest(toolName: string, args: unknown): ToolApprovalRequest {
  if (toolName === "bash") {
    return {
      title: "Approve bash command",
      message: readCommandArg(args) ?? "Run shell command.",
      risk: "high",
    };
  }

  const path = readPathArg(args);
  return {
    title: `Approve ${toolName}`,
    message: path ? `Allow ${toolName} to access ${path}.` : `Allow ${toolName} to execute.`,
    risk: toolName === "write" || toolName === "edit" ? "medium" : "low",
  };
}

function readPathArg(args: unknown): string | undefined {
  if (!args || typeof args !== "object" || !("path" in args)) return undefined;
  const path = args.path;
  return typeof path === "string" ? path : undefined;
}

function readCommandArg(args: unknown): string | undefined {
  if (!args || typeof args !== "object" || !("command" in args)) return undefined;
  const command = args.command;
  return typeof command === "string" ? command : undefined;
}

function isKnownBuiltInTool(toolName: string): boolean {
  return ["read", "ls", "grep", "find", "write", "edit", "bash"].includes(toolName);
}
