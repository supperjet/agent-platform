import { Bash, InMemoryFs, type ExecOptions, type IFileSystem } from "just-bash";
import {
  createSandboxExecResult,
  limitSandboxOutput,
  throwIfSandboxAborted,
  type Sandbox,
  type SandboxExecRequest,
  type SandboxExecResult,
  type SandboxFileStat,
} from "./types.js";
import { normalizeRoots, posixParentDir, resolveSandboxPath } from "./path.js";

export type VirtualSandboxOptions = {
  cwd?: string;
  roots?: readonly string[];
  files?: Record<string, string | Uint8Array>;
};

export function createVirtualSandbox(options: VirtualSandboxOptions = {}): Sandbox {
  const cwd = options.cwd ?? "/workspace";
  const roots = normalizeRoots(cwd, options.roots, "posix");
  const fs = new InMemoryFs(options.files);
  const bash = new Bash({ fs, cwd });

  const resolvePath = (path: string) => resolveSandboxPath(cwd, roots, path, "posix");

  return {
    kind: "virtual",
    cwd,
    roots,
    resolvePath,
    async readFile(path, operationOptions = {}) {
      throwIfSandboxAborted(operationOptions.signal);
      return fs.readFile(resolvePath(path));
    },
    async writeFile(path, content, operationOptions = {}) {
      throwIfSandboxAborted(operationOptions.signal);
      const resolved = resolvePath(path);
      await mkdirpForFs(fs, posixParentDir(resolved));
      await fs.writeFile(resolved, content);
    },
    async stat(path, operationOptions = {}) {
      throwIfSandboxAborted(operationOptions.signal);
      return toSandboxFileStat(await fs.stat(resolvePath(path)));
    },
    async exists(path, operationOptions = {}) {
      throwIfSandboxAborted(operationOptions.signal);
      try {
        return await fs.exists(resolvePath(path));
      } catch {
        return false;
      }
    },
    async readdir(path, operationOptions = {}) {
      throwIfSandboxAborted(operationOptions.signal);
      return fs.readdir(resolvePath(path));
    },
    async mkdirp(path, operationOptions = {}) {
      throwIfSandboxAborted(operationOptions.signal);
      await mkdirpForFs(fs, resolvePath(path));
    },
    exec(request) {
      return execVirtualCommand(bash, resolvePath, request);
    },
  };
}

async function execVirtualCommand(
  bash: Bash,
  resolvePath: (path: string) => string,
  request: SandboxExecRequest,
): Promise<SandboxExecResult> {
  throwIfSandboxAborted(request.signal);
  const startedAt = new Date();
  const timeout = createTimeoutController(request.timeoutMs);
  const signal = mergeAbortSignals(request.signal, timeout.controller.signal);
  try {
    const execOptions: ExecOptions = {
      signal,
      rawScript: request.shell ?? false,
    };
    if (request.args) execOptions.args = [...request.args];
    if (request.cwd) execOptions.cwd = resolvePath(request.cwd);
    if (request.env) execOptions.env = request.env;
    if (request.stdin !== undefined) execOptions.stdin = request.stdin;
    const result = await bash.exec(request.executable, execOptions);
    const limited = limitSandboxOutput(result.stdout, result.stderr, request.outputLimitBytes);
    return createSandboxExecResult({
      exitCode: result.exitCode,
      stdout: limited.stdout,
      stderr: limited.stderr,
      startedAt,
      timedOut: timeout.controller.signal.aborted,
      truncated: limited.truncated,
    });
  } catch (error) {
    if (timeout.controller.signal.aborted) {
      return createSandboxExecResult({
        exitCode: 124,
        stdout: "",
        stderr: `Command timed out after ${request.timeoutMs}ms.`,
        startedAt,
        timedOut: true,
      });
    }
    throw error;
  } finally {
    timeout.dispose();
  }
}

async function mkdirpForFs(fs: IFileSystem, path: string) {
  await fs.mkdir(path, { recursive: true });
}

function toSandboxFileStat(stat: {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink?: boolean;
  size?: number;
  mtime?: Date;
}): SandboxFileStat {
  return {
    isFile: stat.isFile,
    isDirectory: stat.isDirectory,
    ...(stat.isSymbolicLink === undefined ? {} : { isSymbolicLink: stat.isSymbolicLink }),
    ...(stat.size === undefined ? {} : { size: stat.size }),
    ...(stat.mtime === undefined ? {} : { mtime: stat.mtime }),
  };
}

function createTimeoutController(timeoutMs: number | undefined) {
  const controller = new AbortController();
  const timeout = timeoutMs === undefined
    ? undefined
    : setTimeout(() => controller.abort(), timeoutMs);
  return {
    controller,
    dispose() {
      if (timeout) clearTimeout(timeout);
    },
  };
}

function mergeAbortSignals(signal: AbortSignal | undefined, timeoutSignal: AbortSignal) {
  if (!signal) return timeoutSignal;
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal.aborted || timeoutSignal.aborted) {
    controller.abort();
    return controller.signal;
  }
  signal.addEventListener("abort", abort, { once: true });
  timeoutSignal.addEventListener("abort", abort, { once: true });
  return controller.signal;
}
