import { Type } from "@earendil-works/pi-ai";
import type { AnyAgentToolDefinition } from "../tool-registry.js";
import { defineAgentTool } from "../tool-registry.js";
import type { ToolOperations } from "../operations/index.js";
import {
  collectFiles,
  createLineMatcher,
  relativeDisplayPath,
  textResult,
  throwIfAborted
} from "./shared.js";

// grep 参数同时支持字面量和正则，调用方可以按模型能力或安全策略选择使用方式。
const grepParameters = Type.Object({
  pattern: Type.String({ description: "Text or regular expression to search for." }),
  path: Type.Optional(Type.String({ description: "File or directory to search. Defaults to current directory." })),
  ignoreCase: Type.Optional(Type.Boolean({ description: "Perform a case-insensitive search." })),
  literal: Type.Optional(Type.Boolean({ description: "Treat pattern as a literal string." })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return. Defaults to 100." }))
});

/**
 * 创建 grep 内置工具定义。
 *
 * grep 用于在编辑前查找引用和上下文。它不直接依赖 shell grep，而是基于
 * ToolOperations 递归读取文件，这样可以在不同执行环境里保持同一套能力边界。
 */
export function createGrepToolDefinition(operations: ToolOperations): AnyAgentToolDefinition {
  return defineAgentTool({
    name: "grep",
    label: "Grep",
    description: "Search UTF-8 file contents for a literal string or regular expression.",
    promptSnippet: "Search file contents for patterns.",
    promptGuidelines: ["Use grep to find references before editing call sites."],
    sourceInfo: { source: "builtin", label: "agent-core" },
    parameters: grepParameters,
    async execute(_toolCallId, params: {
      pattern: string;
      path?: string;
      ignoreCase?: boolean;
      literal?: boolean;
      limit?: number;
    }, signal?: AbortSignal, _onUpdate?) {
      const root = params.path ?? ".";
      // collectFiles 会处理“传入文件”与“传入目录”两种场景。
      const files = await collectFiles(operations, root, { signal });
      const limit = Math.max(1, params.limit ?? 100);
      const matcher = createLineMatcher(params.pattern, {
        ignoreCase: params.ignoreCase ?? false,
        literal: params.literal ?? false
      });
      const matches: string[] = [];
      for (const file of files) {
        throwIfAborted(signal);
        const content = await operations.readFile(file, { signal });
        const lines = content.split("\n");
        for (let index = 0; index < lines.length; index += 1) {
          throwIfAborted(signal);
          const line = lines[index] ?? "";
          if (!matcher(line)) continue;
          // 使用 path:line: text 形态，方便模型把结果直接映射回 read/edit。
          matches.push(`${relativeDisplayPath(operations, file)}:${index + 1}: ${line}`);
          if (matches.length >= limit) break;
        }
        if (matches.length >= limit) break;
      }
      const text = matches.length > 0 ? matches.join("\n") : "(no matches)";
      return textResult(matches.length >= limit ? `${text}\n\n[Truncated: ${limit} matches limit reached]` : text, {
        matchCount: matches.length,
        ...(matches.length >= limit ? { matchLimitReached: limit } : {})
      });
    }
  });
}
