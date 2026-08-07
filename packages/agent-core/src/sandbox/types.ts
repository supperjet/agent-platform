export type SandboxKind = "virtual" | "local";

export type SandboxFileStat = {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink?: boolean;
  size?: number;
  mtime?: Date;
};

export type SandboxExecRequest = {
  executable: string;
  args?: readonly string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  stdin?: string;
  outputLimitBytes?: number;
  signal?: AbortSignal;
  shell?: boolean;
};

export type SandboxExecResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  startedAt: Date;
  endedAt: Date;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
};

export type Sandbox = {
  kind: SandboxKind;
  cwd: string;
  roots: readonly string[];
  resolvePath(path: string): string;
  readFile(path: string, options?: SandboxOperationOptions): Promise<string>;
  writeFile(path: string, content: string | Uint8Array, options?: SandboxOperationOptions): Promise<void>;
  stat(path: string, options?: SandboxOperationOptions): Promise<SandboxFileStat>;
  exists(path: string, options?: SandboxOperationOptions): Promise<boolean>;
  readdir(path: string, options?: SandboxOperationOptions): Promise<readonly string[]>;
  mkdirp(path: string, options?: SandboxOperationOptions): Promise<void>;
  exec(request: SandboxExecRequest): Promise<SandboxExecResult>;
};

export type SandboxOperationOptions = {
  signal?: AbortSignal;
};

export function throwIfSandboxAborted(signal: AbortSignal | undefined) {
  if (!signal?.aborted) return;
  throw new Error("Sandbox operation aborted.");
}

export function limitSandboxOutput(
  stdout: string,
  stderr: string,
  limitBytes: number | undefined,
): { stdout: string; stderr: string; truncated: boolean } {
  if (limitBytes === undefined || limitBytes < 0) {
    return { stdout, stderr, truncated: false };
  }
  const stdoutBytes = Buffer.byteLength(stdout);
  const stderrBytes = Buffer.byteLength(stderr);
  if (stdoutBytes + stderrBytes <= limitBytes) {
    return { stdout, stderr, truncated: false };
  }
  const combined = `${stdout}${stderr ? `\n${stderr}` : ""}`;
  const truncated = Buffer.from(combined).subarray(0, limitBytes).toString("utf-8");
  return { stdout: truncated, stderr: "", truncated: true };
}

export function createSandboxExecResult(input: {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  startedAt: Date;
  endedAt?: Date;
  timedOut?: boolean;
  truncated?: boolean;
}): SandboxExecResult {
  const endedAt = input.endedAt ?? new Date();
  return {
    exitCode: input.exitCode,
    stdout: input.stdout,
    stderr: input.stderr,
    startedAt: input.startedAt,
    endedAt,
    durationMs: endedAt.getTime() - input.startedAt.getTime(),
    timedOut: input.timedOut ?? false,
    truncated: input.truncated ?? false,
  };
}
