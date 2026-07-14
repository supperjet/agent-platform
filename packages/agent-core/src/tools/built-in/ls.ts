import { Type } from "@earendil-works/pi-ai";
import type { AnyAgentToolDefinition } from "../tool-registry.js";
import { defineAgentTool } from "../tool-registry.js";
import type { ToolOperations } from "../operations/index.js";
import { textResult, throwIfAborted } from "./shared.js";

// ls 只需要目录路径和返回上限；排序、目录后缀等展示策略由工具实现统一处理。
const lsParameters = Type.Object({
  path: Type.Optional(Type.String({ description: "Directory to list. Defaults to current directory." })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of entries to return. Defaults to 500." }))
});

/**
 * 创建 ls 内置工具定义。
 *
 * ls 是最基础的只读探索工具，用于在模型猜路径前先观察目录结构。
 * 文件系统访问全部委托给 ToolOperations，因此 cwd、根目录限制和权限策略不写死在工具里。
 */
export function createLsToolDefinition(operations: ToolOperations): AnyAgentToolDefinition {
  return defineAgentTool({
    name: "ls",
    label: "List",
    description: "List directory contents sorted alphabetically. Directories have a trailing slash.",
    promptSnippet: "List directory contents.",
    promptGuidelines: ["Use ls to inspect a directory before guessing file paths."],
    sourceInfo: { source: "builtin", label: "agent-core" },
    parameters: lsParameters,
    async execute(_toolCallId, params: { path?: string; limit?: number }, signal?: AbortSignal, _onUpdate?) {
      const path = params.path ?? ".";
      const absolutePath = operations.resolvePath(path);
      const pathStat = await operations.stat(path, { signal });
      if (!pathStat.isDirectory()) throw new Error(`Not a directory: ${absolutePath}`);
      const limit = Math.max(1, params.limit ?? 500);
      // 固定字母序输出，保证模型和测试看到稳定结果。
      const entries = [...await operations.readdir(path, { signal })].sort((a, b) => a.localeCompare(b));
      const output: string[] = [];
      for (const entry of entries.slice(0, limit)) {
        throwIfAborted(signal);
        const entryPath = `${path.replace(/\/$/, "")}/${entry}`;
        const entryStat = await operations.stat(entryPath, { signal });
        // 目录追加斜杠，避免调用方再额外 stat 才能区分文件/目录。
        output.push(entryStat.isDirectory() ? `${entry}/` : entry);
      }
      const entryLimitReached = entries.length > limit;
      const text = output.length > 0 ? output.join("\n") : "(empty directory)";
      return textResult(entryLimitReached ? `${text}\n\n[Truncated: ${limit} entries limit reached]` : text, {
        path: absolutePath,
        ...(entryLimitReached ? { entryLimitReached: limit } : {})
      });
    }
  });
}
