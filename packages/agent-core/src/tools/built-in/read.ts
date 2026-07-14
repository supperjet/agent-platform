import { Type } from "@earendil-works/pi-ai";
import type { AnyAgentToolDefinition } from "../tool-registry.js";
import { defineAgentTool } from "../tool-registry.js";
import type { ToolOperations } from "../operations/index.js";
import {
  DEFAULT_TOOL_MAX_BYTES,
  DEFAULT_TOOL_MAX_LINES,
  formatBytes,
  truncateHead
} from "../truncate.js";
import { textResult, throwIfAborted, withTruncationNotice } from "./shared.js";

// read 的参数 schema 保持很薄：只表达模型可传入的结构，不绑定本地文件系统实现。
const readParameters = Type.Object({
  path: Type.String({ description: "Path to the file to read." }),
  offset: Type.Optional(Type.Number({ description: "1-indexed line number to start reading from." })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of lines to return." }))
});

/**
 * 创建 read 内置工具定义。
 *
 * read 只通过 ToolOperations 读取文件，这样同一个工具定义可以落到本地文件系统、
 * 远程工作区或沙箱环境。输出会做截断，避免一次工具调用把上下文打满。
 */
export function createReadToolDefinition(operations: ToolOperations): AnyAgentToolDefinition {
  return defineAgentTool({
    name: "read",
    label: "Read",
    description: `Read a UTF-8 text file. Output is truncated to ${DEFAULT_TOOL_MAX_LINES} lines or ${formatBytes(DEFAULT_TOOL_MAX_BYTES)}.`,
    promptSnippet: "Read file contents.",
    promptGuidelines: ["Use read to inspect files before editing them."],
    sourceInfo: { source: "builtin", label: "agent-core" },
    parameters: readParameters,
    async execute(_toolCallId, params: { path: string; offset?: number; limit?: number }, signal?: AbortSignal, _onUpdate?) {
      const content = await operations.readFile(params.path, { signal });
      throwIfAborted(signal);
      const lines = content.split("\n");
      // offset 使用 1-based 行号，贴近编辑器和诊断信息里的行号表达。
      const start = Math.max(1, params.offset ?? 1);
      const selected = params.limit === undefined
        ? lines.slice(start - 1).join("\n")
        : lines.slice(start - 1, start - 1 + Math.max(0, params.limit)).join("\n");
      // read 优先保留文件开头，方便模型看到声明、import 和上下文结构。
      const truncation = truncateHead(selected);
      return textResult(withTruncationNotice(truncation), { path: operations.resolvePath(params.path), truncation });
    }
  });
}
