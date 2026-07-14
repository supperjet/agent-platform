import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type {
  ToolOperations,
  ToolExecuteOptions,
  ToolCommandResult,
  ToolOperationOptions
} from "./type.js";

/**
 * 本地 ToolOperations 的配置。
 */
export type LocalToolOperationsOptions = {
  /** 本地执行工作目录。 */
  cwd: string;
  /** 允许访问的本地根目录；不传时默认只允许 cwd。 */
  roots?: readonly string[];
};

/**
 * 创建基于本机文件系统和本机 shell 的 ToolOperations。
 *
 * 这是当前默认实现。它集中处理：
 * - cwd/roots 规范化。
 * - 相对路径解析。
 * - 路径越界保护。
 * - 文件读写和目录操作。
 * - shell 命令执行。
 */
export function createLocalToolOperations(options: LocalToolOperationsOptions): ToolOperations {
  const cwd = resolve(options.cwd);
  const roots = (options.roots && options.roots.length > 0 ? options.roots : [cwd]).map((root) => resolve(root));

  /**
   * 将用户输入路径解析到本地绝对路径，并保证结果没有逃出允许 roots。
   */
  function resolveToolPath(inputPath: string): string {
    const absolutePath = isAbsolute(inputPath) ? resolve(inputPath) : resolve(cwd, inputPath || ".");
    assertInsideRoots(absolutePath, roots);
    return absolutePath;
  }

  return {
    cwd,
    roots,
    resolvePath: resolveToolPath,
    async readFile(path, options = {}) {
      throwIfAborted(options.signal);
      return readFile(resolveToolPath(path), { encoding: "utf-8", signal: options.signal });
    },
    async writeFile(path, content, options = {}) {
      throwIfAborted(options.signal);
      const absolutePath = resolveToolPath(path);
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, content, { encoding: "utf-8", signal: options.signal });
    },
    async stat(path, options = {}) {
      throwIfAborted(options.signal);
      return stat(resolveToolPath(path));
    },
    async exists(path, options = {}) {
      throwIfAborted(options.signal);
      try {
        await access(resolveToolPath(path), constants.F_OK);
        return true;
      } catch {
        return false;
      }
    },
    async readdir(path, options = {}) {
      throwIfAborted(options.signal);
      return readdir(resolveToolPath(path));
    },
    async mkdirp(path, options = {}) {
      throwIfAborted(options.signal);
      await mkdir(resolveToolPath(path), { recursive: true });
    },
    execute(command, options = {}) {
      return executeLocalCommand(command, cwd, options);
    }
  };
}

/**
 * 校验路径是否位于任一允许 root 内。
 *
 * 这是本地文件访问的核心安全边界。所有本地文件/目录操作都必须先通过
 * `resolveToolPath`，从而经过这个检查。
 */
function assertInsideRoots(path: string, roots: readonly string[]) {
  for (const root of roots) {
    const rel = relative(root, path);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return;
  }
  throw new Error(`Path is outside allowed roots: ${path}`);
}

/**
 * 在底层 API 不支持 AbortSignal 的地方提供统一的快速失败。
 */
function throwIfAborted(signal: ToolOperationOptions["signal"]) {
  if (!signal?.aborted) return;
  throw new Error("Operation aborted");
}

/**
 * 使用本机 shell 执行命令。
 *
 * 这里是默认实现，不代表所有 ToolOperations 都必须用 shell。远程/容器
 * 环境可以替换为 SSH exec、container exec 或受控 sandbox。
 */
function executeLocalCommand(
  command: string,
  cwd: string,
  options: ToolExecuteOptions
): Promise<ToolCommandResult> {
  return new Promise((resolveResult, reject) => {
    if (options.signal?.aborted) {
      reject(new Error("Operation aborted"));
      return;
    }

    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    // timeout 和 abort 都可能尝试结束同一个子进程，`finish` 用来保证
    // promise 只 resolve/reject 一次，并统一清理计时器和 abort listener。
    const timeout = options.timeoutMs
      ? setTimeout(() => {
        child.kill();
        finish(() => reject(new Error(`Command timed out after ${options.timeoutMs}ms.`)));
      }, options.timeoutMs)
      : undefined;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => {
      child.kill();
      finish(() => reject(new Error("Operation aborted")));
    };

    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (exitCode) => {
      finish(() => resolveResult({ exitCode, stdout, stderr }));
    });
  });
}
