import { Type } from "@earendil-works/pi-ai";
import type { AnyAgentToolDefinition } from "../tool-registry.js";
import { defineAgentTool } from "../tool-registry.js";
import type { ToolOperations } from "../operations/index.js";
import { textResult, throwIfAborted } from "./shared.js";

// edit 采用 exact replacement，而不是 diff/patch；模型必须提供文件中真实存在的 oldText。
const editParameters = Type.Object({
  path: Type.String({ description: "Path to edit." }),
  oldText: Type.String({ description: "Exact text to replace." }),
  newText: Type.String({ description: "Replacement text." }),
  replaceAll: Type.Optional(Type.Boolean({ description: "Replace all occurrences instead of exactly one." }))
});

/**
 * 创建 edit 内置工具定义。
 *
 * edit 面向“小范围精确替换”：默认要求 oldText 在文件中只出现一次，防止模型因为
 * 模糊文本替换误伤多个位置。需要批量替换时，调用方必须显式传入 replaceAll。
 */
export function createEditToolDefinition(operations: ToolOperations): AnyAgentToolDefinition {
  return defineAgentTool({
    name: "edit",
    label: "Edit",
    description: "Replace exact text within a UTF-8 text file.",
    promptSnippet: "Edit files with exact text replacement.",
    promptGuidelines: ["Use read before edit so oldText is exact."],
    sourceInfo: { source: "builtin", label: "agent-core" },
    parameters: editParameters,
    // edit 会读后写，同一轮内必须串行化，避免基于过期内容进行替换。
    executionMode: "sequential",
    async execute(
      _toolCallId,
      params: { path: string; oldText: string; newText: string; replaceAll?: boolean },
      signal?: AbortSignal,
      _onUpdate?
    ) {
      const content = await operations.readFile(params.path, { signal });
      throwIfAborted(signal);
      const occurrences = countOccurrences(content, params.oldText);
      if (occurrences === 0) throw new Error("oldText was not found.");
      if (!params.replaceAll && occurrences !== 1) {
        // 默认单点替换：多处命中时要求模型重新 read 并提供更具体 oldText。
        throw new Error(`oldText matched ${occurrences} times. Set replaceAll to true or provide a more specific oldText.`);
      }
      const nextContent = params.replaceAll
        ? content.split(params.oldText).join(params.newText)
        : content.replace(params.oldText, params.newText);
      await operations.writeFile(params.path, nextContent, { signal });
      throwIfAborted(signal);
      return textResult(`Edited ${operations.resolvePath(params.path)} (${params.replaceAll ? occurrences : 1} replacement${occurrences === 1 ? "" : "s"}).`, {
        path: operations.resolvePath(params.path),
        replacements: params.replaceAll ? occurrences : 1
      });
    }
  });
}

/**
 * 统计 exact substring 出现次数，并在 oldText 为空时提前失败。
 */
function countOccurrences(content: string, needle: string): number {
  if (needle.length === 0) throw new Error("oldText must be non-empty.");
  return content.split(needle).length - 1;
}
