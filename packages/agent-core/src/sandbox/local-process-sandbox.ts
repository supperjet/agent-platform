import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  createSandboxExecResult,
  limitSandboxOutput,
  throwIfSandboxAborted,
  type Sandbox,
  type SandboxExecRequest,
  type SandboxExecResult,
  type SandboxOperationOptions,
} from "./types.js";
import { normalizeRoots, resolveSandboxPath } from "./path.js";

const DEFAULT_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "HOSTNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  "TMPDIR",
  "TMP",
  "TEMP",
] as const;

export type LocalProcessSandboxOptions = {
  cwd: string;
  roots?: readonly string[];
  env?: Record<string, string | undefined>;
};

export function createLocalProcessSandbox(options: LocalProcessSandboxOptions): Sandbox {
  const cwd = resolve(options.cwd);
  const roots = normalizeRoots(cwd, options.roots, "local");
  const baseEnv = resolveBaseEnv(options.env);
  const resolvePath = (path: string) => resolveSandboxPath(cwd, roots, path, "local");

  return {
    kind: "local",
    cwd,
    roots,
    resolvePath,
    async readFile(path, operationOptions = {}) {
      throwIfSandboxAborted(operationOptions.signal);
      return readFile(resolvePath(path), { encoding: "utf-8", signal: operationOptions.signal });
    },
    async writeFile(path, content, operationOptions = {}) {
      throwIfSandboxAborted(operationOptions.signal);
      const resolved = resolvePath(path);
      await mkdir(dirname(resolved), { recursive: true });
      await writeFile(resolved, content, { signal: operationOptions.signal });
    },
    async stat(path, operationOptions = {}) {
      throwIfSandboxAborted(operationOptions.signal);
      const resolved = resolvePath(path);
      const linkStat = await lstat(resolved);
      const s = linkStat.isSymbolicLink() ? await stat(resolved) : linkStat;
      return {
        isFile: s.isFile(),
        isDirectory: s.isDirectory(),
        isSymbolicLink: linkStat.isSymbolicLink(),
        size: s.size,
        mtime: s.mtime,
      };
    },
    async exists(path, operationOptions = {}) {
      throwIfSandboxAborted(operationOptions.signal);
      try {
        await access(resolvePath(path), constants.F_OK);
        return true;
      } catch {
        return false;
      }
    },
    async readdir(path, operationOptions = {}) {
      throwIfSandboxAborted(operationOptions.signal);
      return readdir(resolvePath(path));
    },
    async mkdirp(path, operationOptions = {}) {
      throwIfSandboxAborted(operationOptions.signal);
      await mkdir(resolvePath(path), { recursive: true });
    },
    exec(request) {
      return execLocalCommand(request, cwd, roots, baseEnv);
    },
  };
}

function resolveBaseEnv(userEnv: LocalProcessSandboxOptions["env"]): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {};
  for (const key of DEFAULT_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) base[key] = value;
  }
  if (!userEnv) return base;
  for (const [key, value] of Object.entries(userEnv)) {
    if (value === undefined) delete base[key];
    else base[key] = value;
  }
  return base;
}

function execLocalCommand(
  request: SandboxExecRequest,
  defaultCwd: string,
  roots: readonly string[],
  baseEnv: NodeJS.ProcessEnv,
): Promise<SandboxExecResult> {
  return new Promise((resolveResult, reject) => {
    throwIfSandboxAborted(request.signal);
    const startedAt = new Date();
    const cwd = request.cwd ? resolveSandboxPath(defaultCwd, roots, request.cwd, "local") : defaultCwd;
    const child = spawn(request.executable, request.args ? [...request.args] : [], {
      cwd,
      env: request.env ? { ...baseEnv, ...request.env } : baseEnv,
      shell: request.shell ?? false,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let truncated = false;

    const killTree = () => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    };

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      request.signal?.removeEventListener("abort", onAbort);
      fn();
    };

    const timeout = request.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
        timedOut = true;
        killTree();
        finish(() => resolveResult(createSandboxExecResult({
          exitCode: 124,
          stdout,
          stderr: `${stderr}${stderr ? "\n" : ""}Command timed out after ${request.timeoutMs}ms.`,
          startedAt,
          timedOut: true,
          truncated,
        })));
      }, request.timeoutMs);

    const onAbort = () => {
      killTree();
      finish(() => reject(new Error("Sandbox operation aborted.")));
    };

    request.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      const limited = limitSandboxOutput(stdout, stderr, request.outputLimitBytes);
      stdout = limited.stdout;
      stderr = limited.stderr;
      truncated ||= limited.truncated;
      if (truncated) killTree();
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      const limited = limitSandboxOutput(stdout, stderr, request.outputLimitBytes);
      stdout = limited.stdout;
      stderr = limited.stderr;
      truncated ||= limited.truncated;
      if (truncated) killTree();
    });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (exitCode) => {
      if (timedOut) return;
      finish(() => resolveResult(createSandboxExecResult({
        exitCode,
        stdout,
        stderr,
        startedAt,
        truncated,
      })));
    });

    if (request.stdin !== undefined) {
      child.stdin.end(request.stdin);
    } else {
      child.stdin.end();
    }
  });
}
