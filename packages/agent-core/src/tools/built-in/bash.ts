import { Type } from "@earendil-works/pi-ai";
import type { AnyAgentToolDefinition } from "../tool-registry.js";
import { defineAgentTool } from "../tool-registry.js";
import type { ToolOperations } from "../operations/index.js";
import { truncateTail } from "../truncate.js";
import { textResult, withTruncationNotice } from "./shared.js";

// bash 的参数只暴露命令和超时；cwd、环境变量、权限和沙箱策略由 ToolOperations 决定。
const bashParameters = Type.Object({
  command: Type.String({ description: "Shell command to execute in the tool operations cwd." }),
  timeoutMs: Type.Optional(Type.Number({ description: "Optional timeout in milliseconds. Defaults to 30000." }))
});

/**
 * 创建 bash 内置工具定义。
 *
 * bash 是核心工具里权限面最大的能力，因此工具自身只定义交互契约；
 * 是否允许执行、在哪执行、如何限制根目录/超时/取消，都交给 ToolOperations 实现。
 */
export function createBashToolDefinition(operations: ToolOperations): AnyAgentToolDefinition {
  return defineAgentTool({
    name: "bash",
    label: "Bash",
    description: "Execute a shell command in the configured working directory.",
    promptSnippet: "Run shell commands.",
    promptGuidelines: ["Explain why a command is needed when it may change files or take time."],
    sourceInfo: { source: "builtin", label: "agent-core" },
    parameters: bashParameters,
    // shell 命令可能修改外部状态，串行执行更容易追踪副作用。
    executionMode: "sequential",
    async execute(_toolCallId, params: { command: string; timeoutMs?: number }, signal?: AbortSignal, _onUpdate?) {
      // 将 agent loop 的取消信号透传给执行环境，支持中断长时间命令。
      const executeOptions = signal
        ? { timeoutMs: params.timeoutMs ?? 30_000, signal }
        : { timeoutMs: params.timeoutMs ?? 30_000 };
      const result = await operations.execute(params.command, executeOptions);
      // stdout/stderr 合并成单个文本结果，details 中保留 exitCode 便于上层判断成败。
      const output = [
        result.stdout.trimEnd(),
        result.stderr.trimEnd()
      ].filter(Boolean).join("\n");
      // 命令输出通常重要信息在末尾，bash 因此保留尾部内容。
      const truncation = truncateTail(output);
      return textResult(withTruncationNotice(truncation), {
        exitCode: result.exitCode,
        truncation
      });
    }
  });
}
