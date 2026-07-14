import type { ToolOperations } from "../operations/index.js";
import type { ToolTruncation } from "../truncate.js";

export type BuiltInToolExecutionOptions = {
  signal?: AbortSignal | undefined;
};

/**
 * 统一构造 Pi Agent 工具返回值。
 *
 * content 面向模型，details 面向 runtime/调试/测试，避免把结构化信息塞进纯文本里。
 */
export function textResult(text: string, details: Record<string, unknown>): {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
} {
  return {
    content: [{ type: "text", text }],
    details
  };
}

/**
 * 在文本被截断时追加可读提示；未截断时保持原内容不变。
 */
export function withTruncationNotice(truncation: ToolTruncation): string {
  if (!truncation.truncated) return truncation.content;
  return `${truncation.content}\n\n[Truncated: ${truncation.truncatedBy} limit reached; showing ${truncation.outputLines} of ${truncation.totalLines} lines]`;
}

/**
 * 收集一个文件或目录下可读取的文件路径。
 *
 * 如果 root 本身是文件，直接返回该文件；如果是目录，则递归遍历目录树。
 */
export async function collectFiles(
  operations: ToolOperations,
  root: string,
  options: BuiltInToolExecutionOptions = {}
): Promise<string[]> {
  throwIfAborted(options.signal);
  const rootStat = await operations.stat(root, options);
  if (rootStat.isFile()) return [root];
  const files: string[] = [];
  await walkPaths(operations, root, async (path, pathStat) => {
    if (pathStat.isFile()) files.push(path);
  }, options);
  return files;
}

/**
 * 深度优先遍历文件树，并把每个路径的 stat 结果传给 visit。
 *
 * 这里不直接接触 fs，所有路径解析和权限控制都继续交给 ToolOperations。
 */
export async function walkPaths(
  operations: ToolOperations,
  root: string,
  visit: (path: string, pathStat: { isDirectory(): boolean; isFile(): boolean }) => Promise<void> | void,
  options: BuiltInToolExecutionOptions = {}
) {
  throwIfAborted(options.signal);
  const rootStat = await operations.stat(root, options);
  throwIfAborted(options.signal);
  await visit(root, rootStat);
  if (!rootStat.isDirectory()) return;
  for (const entry of await operations.readdir(root, options)) {
    throwIfAborted(options.signal);
    if (shouldSkipEntry(entry)) continue;
    await walkPaths(operations, `${root.replace(/\/$/, "")}/${entry}`, visit, options);
  }
}

/**
 * 根据参数创建逐行匹配函数。
 *
 * literal=true 时使用普通子串匹配；否则把 pattern 当作正则表达式。
 */
export function createLineMatcher(
  pattern: string,
  options: { ignoreCase: boolean; literal: boolean }
): (line: string) => boolean {
  if (options.literal) {
    const needle = options.ignoreCase ? pattern.toLowerCase() : pattern;
    return (line) => (options.ignoreCase ? line.toLowerCase() : line).includes(needle);
  }
  const regex = new RegExp(pattern, options.ignoreCase ? "i" : "");
  return (line) => regex.test(line);
}

/**
 * 将绝对路径转换为相对 cwd 的展示路径。
 *
 * 工具结果给模型阅读时，相对路径通常更短，也更适合直接传回 read/edit。
 */
export function relativeDisplayPath(operations: ToolOperations, path: string): string {
  const absolutePath = operations.resolvePath(path);
  if (absolutePath.startsWith(`${operations.cwd}/`)) return absolutePath.slice(operations.cwd.length + 1);
  return absolutePath;
}

/**
 * 跳过高噪声或生成物目录，避免 grep/find 默认遍历过慢、输出过大。
 */
function shouldSkipEntry(entry: string): boolean {
  return entry === ".git" || entry === "node_modules" || entry === "dist";
}

/**
 * 内置工具共用的取消检查。
 */
export function throwIfAborted(signal: AbortSignal | undefined) {
  if (!signal?.aborted) return;
  throw new Error("Operation aborted");
}
