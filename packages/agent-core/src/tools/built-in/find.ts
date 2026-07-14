import { Type } from "@earendil-works/pi-ai";
import type { AnyAgentToolDefinition } from "../tool-registry.js";
import { defineAgentTool } from "../tool-registry.js";
import type { ToolOperations } from "../operations/index.js";
import { relativeDisplayPath, textResult, walkPaths } from "./shared.js";

// find 只做轻量路径匹配；更复杂的文件内容搜索交给 grep。
const findParameters = Type.Object({
  path: Type.Optional(Type.String({ description: "Directory to search. Defaults to current directory." })),
  name: Type.Optional(Type.String({ description: "Case-insensitive filename substring to match." })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of paths to return. Defaults to 200." }))
});

/**
 * 创建 find 内置工具定义。
 *
 * find 用于在不知道完整路径时快速定位文件或目录。递归遍历逻辑复用 shared helper，
 * 让跳过 node_modules/dist/.git 等目录的策略在只读搜索工具之间保持一致。
 */
export function createFindToolDefinition(operations: ToolOperations): AnyAgentToolDefinition {
  return defineAgentTool({
    name: "find",
    label: "Find",
    description: "Find files and directories by path/name substring.",
    promptSnippet: "Find files and directories by name.",
    promptGuidelines: ["Use find when you know part of a filename but not its location."],
    sourceInfo: { source: "builtin", label: "agent-core" },
    parameters: findParameters,
    async execute(_toolCallId, params: { path?: string; name?: string; limit?: number }, signal?: AbortSignal, _onUpdate?) {
      const root = params.path ?? ".";
      const limit = Math.max(1, params.limit ?? 200);
      // 空 name 表示列出路径树；非空 name 使用大小写不敏感的子串匹配。
      const needle = (params.name ?? "").toLowerCase();
      const matches: string[] = [];
      await walkPaths(operations, root, async (path) => {
        if (matches.length >= limit) return;
        if (!needle || path.toLowerCase().includes(needle)) {
          matches.push(relativeDisplayPath(operations, path));
        }
      }, { signal });
      const text = matches.length > 0 ? matches.join("\n") : "(no matches)";
      return textResult(matches.length >= limit ? `${text}\n\n[Truncated: ${limit} paths limit reached]` : text, {
        matchCount: matches.length,
        ...(matches.length >= limit ? { pathLimitReached: limit } : {})
      });
    }
  });
}
