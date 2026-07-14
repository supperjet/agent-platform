import { Type } from "@earendil-works/pi-ai";
import type { AnyAgentToolDefinition } from "../tool-registry.js";
import { defineAgentTool } from "../tool-registry.js";
import type { ToolOperations } from "../operations/index.js";
import { textResult, throwIfAborted } from "./shared.js";

// write 是整文件写入工具；局部替换应使用 edit。
const writeParameters = Type.Object({
  path: Type.String({ description: "Path to create or overwrite." }),
  content: Type.String({ description: "UTF-8 text content to write." })
});

/**
 * 创建 write 内置工具定义。
 *
 * write 会创建或覆盖整个 UTF-8 文本文件，因此被声明为 sequential，避免和其他
 * 会修改文件系统的工具并发交错。真正的写入权限和路径边界由 ToolOperations 控制。
 */
export function createWriteToolDefinition(operations: ToolOperations): AnyAgentToolDefinition {
  return defineAgentTool({
    name: "write",
    label: "Write",
    description: "Create or overwrite a UTF-8 text file.",
    promptSnippet: "Create or overwrite files.",
    promptGuidelines: ["Use write only when creating a new file or intentionally replacing a whole file."],
    sourceInfo: { source: "builtin", label: "agent-core" },
    parameters: writeParameters,
    // 修改文件系统的工具按顺序执行，降低同一轮多个写操作互相覆盖的风险。
    executionMode: "sequential",
    async execute(_toolCallId, params: { path: string; content: string }, signal?: AbortSignal, _onUpdate?) {
      await operations.writeFile(params.path, params.content, { signal });
      throwIfAborted(signal);
      return textResult(`Wrote ${params.content.length} characters to ${operations.resolvePath(params.path)}.`, {
        path: operations.resolvePath(params.path),
        bytes: Buffer.byteLength(params.content, "utf-8")
      });
    }
  });
}
