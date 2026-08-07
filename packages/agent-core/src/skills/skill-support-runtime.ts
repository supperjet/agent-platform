import { readFile, realpath } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative } from "node:path";
import type { AgentRuntimeEvent } from "../contracts.js";
import {
  parsePromptTemplateFile,
  renderPromptTemplate,
  type RenderedPromptTemplate,
} from "../prompt/prompt-template.js";
import {
  createLocalProcessSandbox,
  createVirtualSandbox,
  type Sandbox,
  type SandboxExecResult,
  type SandboxKind,
} from "../sandbox/index.js";
import {
  resolveSkillSupportFileTrustPolicy,
  type LoadedSkill,
  type SkillScriptArgumentDefinition,
  type SkillScriptArgumentType,
  type SkillRegistry,
  type SkillSupportFile,
  type SkillSupportFileContent,
} from "./skill-loader.js";

export type SkillSupportReadRequest = {
  skillName: string;
  fileName: string;
};

export type SkillSupportRenderRequest = {
  skillName: string;
  templateName: string;
  variables?: Record<string, string>;
};

export type SkillScriptRunRequest = {
  skillName: string;
  scriptName: string;
  args?: readonly string[];
  namedArgs?: Record<string, unknown>;
  cwd?: string;
  sandboxKind?: SandboxKind;
  timeoutMs?: number;
  outputLimitBytes?: number;
  signal?: AbortSignal;
};

export type SkillScriptExecutionOutcome =
  | "succeeded"
  | "invalid_arguments"
  | "failed"
  | "timed_out";

export type SkillScriptStructuredOutput = {
  status?: "ok" | "error";
  result?: unknown;
  logs?: readonly string[];
  message?: string;
  errorCode?: string;
};

export type SkillSupportReadResult =
  | {
      status: "completed";
      skillName: string;
      fileName: string;
      file: SkillSupportFileContent;
    }
  | SkillSupportRejectedResult;

export type SkillSupportRenderResult =
  | {
      status: "completed";
      skillName: string;
      templateName: string;
      template: RenderedPromptTemplate;
    }
  | SkillSupportRejectedResult;

export type SkillScriptRunResult =
  | {
      status: "completed";
      skillName: string;
      scriptName: string;
      sandboxKind: SandboxKind;
      exec: SandboxExecResult;
      outcome: SkillScriptExecutionOutcome;
      structuredOutput?: SkillScriptStructuredOutput;
    }
  | {
      status: "rejected" | "failed";
      skillName: string;
      scriptName: string;
      sandboxKind?: SandboxKind;
      errorCode: "SCRIPT_REJECTED" | "SCRIPT_NOT_FOUND" | "SCRIPT_INVALID_ARGUMENTS" | "SCRIPT_EXECUTION_FAILED";
      message: string;
      policyRejected: boolean;
    };

export type SkillSupportRejectedResult = {
  status: "rejected" | "failed";
  skillName: string;
  fileName: string;
  errorCode:
    | "SUPPORT_FILE_NOT_FOUND"
    | "SUPPORT_FILE_REJECTED"
    | "SUPPORT_FILE_READ_FAILED"
    | "TEMPLATE_RENDER_FAILED";
  message: string;
  policyRejected: boolean;
};

export type SkillSupportRuntimeOptions = {
  registry: SkillRegistry;
  sessionId?: string;
  workingDirectory?: string;
  defaultTimeoutMs?: number;
  defaultOutputLimitBytes?: number;
  onEvent?: (event: AgentRuntimeEvent) => void;
  createSandbox?: (input: {
    kind: SandboxKind;
    cwd: string;
    skill: LoadedSkill;
    script: SkillSupportFile;
  }) => Sandbox;
};

export abstract class SkillSupportRuntime {
  abstract read(request: SkillSupportReadRequest): Promise<SkillSupportReadResult>;
  abstract renderTemplate(request: SkillSupportRenderRequest): Promise<SkillSupportRenderResult>;
  abstract runScript(request: SkillScriptRunRequest): Promise<SkillScriptRunResult>;
}

export function createSkillSupportRuntime(
  options: SkillSupportRuntimeOptions,
): SkillSupportRuntime {
  return new DefaultSkillSupportRuntime(options);
}

class DefaultSkillSupportRuntime extends SkillSupportRuntime {
  private readonly sessionId: string;
  private readonly workingDirectory: string;
  private readonly defaultTimeoutMs: number;
  private readonly defaultOutputLimitBytes: number;

  constructor(private readonly options: SkillSupportRuntimeOptions) {
    super();
    this.sessionId = options.sessionId ?? "agent-core";
    this.workingDirectory = options.workingDirectory ?? process.cwd();
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 5_000;
    this.defaultOutputLimitBytes = options.defaultOutputLimitBytes ?? 1024 * 1024;
  }

  async read(request: SkillSupportReadRequest): Promise<SkillSupportReadResult> {
    const resolution = this.resolveSupportFile(request.skillName, request.fileName);
    if (resolution.status !== "found") return resolution.result;
    const { skill, file } = resolution;
    const policy = resolveSkillSupportFileTrustPolicy(file);
    if (!policy.canRead) {
      return rejectSupportFile({
        skillName: skill.name,
        fileName: file.label,
        errorCode: "SUPPORT_FILE_REJECTED",
        message: `Skill support file read denied by policy: ${policy.reason}`,
        policyRejected: true,
      });
    }
    try {
      await assertSupportFilePathInsideSkill(skill, file);
      return {
        status: "completed",
        skillName: skill.name,
        fileName: file.label,
        file: {
          file,
          content: await readFile(file.path, "utf-8"),
        },
      };
    } catch (error) {
      return rejectSupportFile({
        skillName: skill.name,
        fileName: file.label,
        errorCode: "SUPPORT_FILE_READ_FAILED",
        message: `Could not read skill support file: ${readErrorMessage(error)}`,
        policyRejected: false,
      });
    }
  }

  async renderTemplate(
    request: SkillSupportRenderRequest,
  ): Promise<SkillSupportRenderResult> {
    const resolution = this.resolveSupportFile(request.skillName, request.templateName, "template");
    if (resolution.status !== "found") {
      return resolution.result;
    }
    const { skill, file } = resolution;
    const readResult = await this.read({
      skillName: skill.name,
      fileName: file.sourceInfo.label,
    });
    if (readResult.status !== "completed") {
      return readResult;
    }
    try {
      const parsed = parsePromptTemplateFile(readResult.file.content);
      const template = renderPromptTemplate({
        template: {
          name: createSkillTemplateName(file.sourceInfo.label),
          label: file.label.replace(/\.[^.]+$/, ""),
          ...parsed.metadata,
          content: parsed.content,
          sourceInfo: file.sourceInfo,
          priority: skill.priority,
          loadedAt: skill.loadedAt,
        },
        variables: request.variables ?? {},
      });
      return {
        status: "completed",
        skillName: skill.name,
        templateName: template.name,
        template,
      };
    } catch (error) {
      return rejectSupportFile({
        skillName: skill.name,
        fileName: file.label,
        errorCode: "TEMPLATE_RENDER_FAILED",
        message: `Could not render skill template: ${readErrorMessage(error)}`,
        policyRejected: false,
      });
    }
  }

  async runScript(request: SkillScriptRunRequest): Promise<SkillScriptRunResult> {
    const skill = this.options.registry.getDefinition(request.skillName);
    if (!skill) {
      return this.failScript({
        skillName: request.skillName,
        scriptName: request.scriptName,
        errorCode: "SCRIPT_NOT_FOUND",
        message: `Skill not found: ${request.skillName}`,
        policyRejected: false,
      });
    }

    const scriptResolution = resolveSkillScript(skill, request.scriptName);
    if (scriptResolution.status !== "found") {
      return this.failScript({
        skillName: skill.name,
        scriptName: request.scriptName,
        errorCode: "SCRIPT_NOT_FOUND",
        message: scriptResolution.message,
        policyRejected: false,
      });
    }

    const script = scriptResolution.script;
    const inferredScriptMetadata = inferScriptRuntimeMetadata(script);
    const sandboxKind = request.sandboxKind ?? inferredScriptMetadata.sandbox ?? "virtual";
    const policy = resolveSkillSupportFileTrustPolicy(script);
    this.emit({
      type: "skill_script_policy_checked",
      sessionId: this.sessionId,
      skillName: skill.name,
      scriptName: script.label,
      sourceLabel: script.sourceInfo.label,
      sourceScope: script.sourceInfo.scope,
      sandboxKind,
      canExecute: policy.canExecute,
      reason: policy.reason,
    });
    if (!policy.canExecute) {
      return this.failScript({
        skillName: skill.name,
        scriptName: script.label,
        sandboxKind,
        errorCode: "SCRIPT_REJECTED",
        message: `Skill script execute denied by policy: ${policy.reason}`,
        policyRejected: true,
      });
    }
    if (sandboxKind === "local" && inferredScriptMetadata.sandbox !== "local") {
      return this.failScript({
        skillName: skill.name,
        scriptName: script.label,
        sandboxKind,
        errorCode: "SCRIPT_REJECTED",
        message: "Local sandbox execution requires script metadata sandbox: local.",
        policyRejected: true,
      });
    }
    const interpreter = inferredScriptMetadata.interpreter ?? "bash";
    if (interpreter === "node" && sandboxKind !== "local") {
      return this.failScript({
        skillName: skill.name,
        scriptName: script.label,
        sandboxKind,
        errorCode: "SCRIPT_REJECTED",
        message: "Node script execution requires sandbox: local.",
        policyRejected: true,
      });
    }
    const argumentResolution = resolveScriptArguments({
      definitions: inferredScriptMetadata.args ?? [],
      argv: request.args ?? [],
      namedArgs: request.namedArgs ?? {},
    });
    if (argumentResolution.status === "rejected") {
      return this.failScript({
        skillName: skill.name,
        scriptName: script.label,
        sandboxKind,
        errorCode: "SCRIPT_INVALID_ARGUMENTS",
        message: argumentResolution.message,
        policyRejected: false,
      });
    }

    let scriptContent: string;
    try {
      await assertSupportFilePathInsideSkill(skill, script);
      scriptContent = stripSkillScriptFrontmatter(await readFile(script.path, "utf-8"));
    } catch (error) {
      return this.failScript({
        skillName: skill.name,
        scriptName: script.label,
        sandboxKind,
        errorCode: "SCRIPT_EXECUTION_FAILED",
        message: `Could not prepare skill script: ${readErrorMessage(error)}`,
        policyRejected: false,
      });
    }

    const cwd = request.cwd ?? this.workingDirectory;
    const timeoutMs = request.timeoutMs ?? inferredScriptMetadata.timeoutMs ?? this.defaultTimeoutMs;
    const outputLimitBytes = request.outputLimitBytes
      ?? inferredScriptMetadata.outputLimitBytes
      ?? this.defaultOutputLimitBytes;
    const sandbox = this.createSandbox({
      kind: sandboxKind,
      cwd,
      skill,
      script,
    });
    this.emit({
      type: "skill_script_started",
      sessionId: this.sessionId,
      skillName: skill.name,
      scriptName: script.label,
      sourceLabel: script.sourceInfo.label,
      sandboxKind,
      cwd: sandbox.cwd,
      timeoutMs,
    });

    try {
      const exec = await executeScriptInSandbox({
        sandbox,
        interpreter,
        scriptContent,
        timeoutMs,
        outputLimitBytes,
        args: argumentResolution.args,
        namedArgs: argumentResolution.namedArgs,
        ...(request.signal ? { signal: request.signal } : {}),
      });
      const structuredOutput = parseStructuredOutput(exec.stdout);
      const outcome = classifyScriptExecution(exec, structuredOutput);
      this.emit({
        type: "skill_script_completed",
        sessionId: this.sessionId,
        skillName: skill.name,
        scriptName: script.label,
        sandboxKind,
        exitCode: exec.exitCode,
        outcome,
        durationMs: exec.durationMs,
        timedOut: exec.timedOut,
        truncated: exec.truncated,
        stdoutPreview: preview(exec.stdout),
        stderrPreview: preview(exec.stderr),
      });
      return {
        status: "completed",
        skillName: skill.name,
        scriptName: script.label,
        sandboxKind,
        exec,
        outcome,
        ...(structuredOutput ? { structuredOutput } : {}),
      };
    } catch (error) {
      return this.failScript({
        skillName: skill.name,
        scriptName: script.label,
        sandboxKind,
        errorCode: "SCRIPT_EXECUTION_FAILED",
        message: readErrorMessage(error),
        policyRejected: false,
      });
    }
  }

  private createSandbox(input: {
    kind: SandboxKind;
    cwd: string;
    skill: LoadedSkill;
    script: SkillSupportFile;
  }): Sandbox {
    if (this.options.createSandbox) return this.options.createSandbox(input);
    if (input.kind === "virtual") {
      return createVirtualSandbox({
        cwd: "/workspace",
        roots: ["/workspace"],
      });
    }
    return createLocalProcessSandbox({
      cwd: input.cwd,
      roots: [input.cwd],
    });
  }

  private failScript(input: {
    skillName: string;
    scriptName: string;
    sandboxKind?: SandboxKind;
    errorCode: "SCRIPT_REJECTED" | "SCRIPT_NOT_FOUND" | "SCRIPT_INVALID_ARGUMENTS" | "SCRIPT_EXECUTION_FAILED";
    message: string;
    policyRejected: boolean;
  }): SkillScriptRunResult {
    this.emit({
      type: "skill_script_failed",
      sessionId: this.sessionId,
      skillName: input.skillName,
      scriptName: input.scriptName,
      ...(input.sandboxKind ? { sandboxKind: input.sandboxKind } : {}),
      errorCode: input.errorCode,
      message: input.message,
      policyRejected: input.policyRejected,
    });
    return {
      status: input.errorCode === "SCRIPT_REJECTED" ? "rejected" : "failed",
      skillName: input.skillName,
      scriptName: input.scriptName,
      ...(input.sandboxKind ? { sandboxKind: input.sandboxKind } : {}),
      errorCode: input.errorCode,
      message: input.message,
      policyRejected: input.policyRejected,
    };
  }

  private emit(event: AgentRuntimeEvent) {
    this.options.onEvent?.(event);
  }

  private resolveSupportFile(
    skillName: string,
    fileName: string,
    kind?: SkillSupportFile["kind"],
  ): { status: "found"; skill: LoadedSkill; file: SkillSupportFile } | { status: "missing"; result: SkillSupportRejectedResult } {
    const skill = this.options.registry.getDefinition(skillName);
    if (!skill) {
      return {
        status: "missing",
        result: rejectSupportFile({
          skillName,
          fileName,
          errorCode: "SUPPORT_FILE_NOT_FOUND",
          message: `Skill not found: ${skillName}`,
          policyRejected: false,
        }),
      };
    }
    const candidates = skill.supportFiles.filter((file) =>
      (!kind || file.kind === kind) && matchesSupportFileName(file, fileName)
    );
    if (candidates.length === 1 && candidates[0]) {
      return { status: "found", skill, file: candidates[0] };
    }
    return {
      status: "missing",
      result: rejectSupportFile({
        skillName: skill.name,
        fileName,
        errorCode: "SUPPORT_FILE_NOT_FOUND",
        message: candidates.length > 1
          ? `Skill support file name is ambiguous: ${skill.name}/${fileName}`
          : `Skill support file not found: ${skill.name}/${fileName}`,
        policyRejected: false,
      }),
    };
  }
}

function rejectSupportFile(input: {
  skillName: string;
  fileName: string;
  errorCode: SkillSupportRejectedResult["errorCode"];
  message: string;
  policyRejected: boolean;
}): SkillSupportRejectedResult {
  return {
    status: input.errorCode === "SUPPORT_FILE_REJECTED" ? "rejected" : "failed",
    skillName: input.skillName,
    fileName: input.fileName,
    errorCode: input.errorCode,
    message: input.message,
    policyRejected: input.policyRejected,
  };
}

function matchesSupportFileName(file: SkillSupportFile, fileName: string) {
  return file.label === fileName
    || file.label.replace(/\.[^.]+$/, "") === fileName
    || file.sourceInfo.label === fileName
    || file.sourceInfo.label.endsWith(`/${fileName}`);
}

async function assertSupportFilePathInsideSkill(
  skill: LoadedSkill,
  file: SkillSupportFile,
) {
  if (!skill.sourceInfo.path) {
    throw new Error("Skill source path is required for support file access.");
  }
  if (isAbsolute(file.sourceInfo.label)) {
    throw new Error(`Skill support file source label must be relative: ${file.sourceInfo.label}`);
  }
  const skillDir = dirname(skill.sourceInfo.path);
  const [realSkillDir, realFilePath] = await Promise.all([
    realpath(skillDir),
    realpath(file.path),
  ]);
  const relativePath = relative(realSkillDir, realFilePath);
  if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`Skill support file path is outside skill directory: ${file.path}`);
  }
}

function resolveSkillScript(
  skill: LoadedSkill,
  scriptName: string,
): { status: "found"; script: SkillSupportFile } | { status: "missing"; message: string } {
  const scripts = skill.supportFiles.filter((file) => file.kind === "script");
  const candidates = scripts.filter((script) =>
    script.label === scriptName ||
    script.label.replace(/\.[^.]+$/, "") === scriptName ||
    script.sourceInfo.label.endsWith(`/scripts/${scriptName}`)
  );
  if (candidates.length === 1 && candidates[0]) {
    return { status: "found", script: candidates[0] };
  }
  if (candidates.length > 1) {
    return {
      status: "missing",
      message: `Skill script name is ambiguous: ${scriptName}`,
    };
  }
  return {
    status: "missing",
    message: `Skill script not found: ${skill.name}/${scriptName}`,
  };
}

function stripSkillScriptFrontmatter(content: string) {
  return content
    .replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "")
    .replace(/^\/\*---\r?\n[\s\S]*?\r?\n---\*\/(?:\r?\n|$)/, "");
}

function executeScriptInSandbox(input: {
  sandbox: Sandbox;
  interpreter: "bash" | "node";
  scriptContent: string;
  timeoutMs: number;
  outputLimitBytes: number;
  args: readonly string[];
  namedArgs: Readonly<Record<string, unknown>>;
  signal?: AbortSignal;
}): Promise<SandboxExecResult> {
  const common = {
    timeoutMs: input.timeoutMs,
    outputLimitBytes: input.outputLimitBytes,
    env: createSkillScriptEnv(input.args, input.namedArgs),
    ...(input.signal ? { signal: input.signal } : {}),
  };
  if (input.interpreter === "node") {
    return input.sandbox.exec({
      executable: process.execPath,
      args: ["-"],
      stdin: input.scriptContent,
      ...common,
    });
  }
  return input.sandbox.exec({
    executable: input.scriptContent,
    shell: true,
    ...common,
  });
}

function createSkillScriptEnv(
  args: readonly string[],
  namedArgs: Readonly<Record<string, unknown>>,
): Record<string, string> {
  return {
    SKILL_ARGS: args.join(" "),
    SKILL_ARGS_JSON: JSON.stringify(args),
    SKILL_NAMED_ARGS_JSON: JSON.stringify(namedArgs),
    SKILL_INPUT_JSON: JSON.stringify({ args, namedArgs }),
  };
}

function inferScriptRuntimeMetadata(script: SkillSupportFile): {
  sandbox?: SandboxKind;
  interpreter?: "bash" | "node";
  timeoutMs?: number;
  outputLimitBytes?: number;
  args?: readonly SkillScriptArgumentDefinition[];
} {
  if (script.script) return script.script;
  const extension = extname(script.path).toLowerCase();
  if (extension === ".sh" || extension === ".bash") {
    return { sandbox: "virtual", interpreter: "bash" };
  }
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") {
    return { sandbox: "local", interpreter: "node" };
  }
  return {};
}

function resolveScriptArguments(input: {
  definitions: readonly SkillScriptArgumentDefinition[];
  argv: readonly string[];
  namedArgs: Record<string, unknown>;
}): { status: "ok"; args: readonly string[]; namedArgs: Record<string, unknown> } | { status: "rejected"; message: string } {
  if (input.definitions.length === 0) {
    const parsedNamedArgs = parseNamedArgsFromArgv(input.argv);
    return {
      status: "ok",
      args: parsedNamedArgs.args,
      namedArgs: { ...parsedNamedArgs.namedArgs, ...input.namedArgs },
    };
  }
  const parsedNamedArgs = parseNamedArgsFromArgv(input.argv);
  const rawNamedArgs = { ...parsedNamedArgs.namedArgs, ...input.namedArgs };
  const definedNames = new Set(input.definitions.map((definition) => definition.name));
  for (const name of Object.keys(rawNamedArgs)) {
    if (!definedNames.has(name)) {
      return {
        status: "rejected",
        message: `Unknown script argument: ${name}. Expected: ${[...definedNames].join(", ") || "(none)"}.`,
      };
    }
  }
  const namedArgs: Record<string, unknown> = {};
  for (const definition of input.definitions) {
    const rawValue = rawNamedArgs[definition.name];
    if (rawValue === undefined || rawValue === "") {
      if (definition.required) {
        return {
          status: "rejected",
          message: `Missing required script argument: ${definition.name}.`,
        };
      }
      continue;
    }
    const coerced = coerceScriptArgument(definition, rawValue);
    if (coerced.status === "rejected") return coerced;
    namedArgs[definition.name] = coerced.value;
  }
  return {
    status: "ok",
    args: parsedNamedArgs.args,
    namedArgs,
  };
}

function parseNamedArgsFromArgv(argv: readonly string[]) {
  const args: string[] = [];
  const namedArgs: Record<string, unknown> = {};
  for (const arg of argv) {
    const separator = arg.indexOf("=");
    if (separator <= 0) {
      args.push(arg);
      continue;
    }
    namedArgs[arg.slice(0, separator)] = arg.slice(separator + 1);
  }
  return { args, namedArgs };
}

function coerceScriptArgument(
  definition: SkillScriptArgumentDefinition,
  value: unknown,
): { status: "ok"; value: unknown } | { status: "rejected"; message: string } {
  try {
    return {
      status: "ok",
      value: coerceScriptArgumentValue(definition.type, value),
    };
  } catch (error) {
    return {
      status: "rejected",
      message: `Invalid script argument ${definition.name}: ${readErrorMessage(error)}`,
    };
  }
}

function coerceScriptArgumentValue(type: SkillScriptArgumentType, value: unknown): unknown {
  if (type.endsWith("[]")) {
    const elementType = type.slice(0, -2) as "string" | "number" | "boolean";
    const values = Array.isArray(value)
      ? value
      : typeof value === "string"
        ? value.split(",").map((item) => item.trim()).filter(Boolean)
        : [value];
    return values.map((item) => coerceScriptArgumentValue(elementType, item));
  }
  if (type === "string") return String(value);
  if (type === "number") {
    const parsed = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(parsed)) return parsed;
    throw new Error(`expected number, received ${JSON.stringify(value)}`);
  }
  if (type === "boolean") {
    if (typeof value === "boolean") return value;
    if (value === "true") return true;
    if (value === "false") return false;
    throw new Error(`expected boolean, received ${JSON.stringify(value)}`);
  }
  if (type === "json") {
    if (typeof value !== "string") return value;
    return JSON.parse(value);
  }
  return value;
}

function parseStructuredOutput(stdout: string): SkillScriptStructuredOutput | undefined {
  const line = stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean).at(-1);
  if (!line) return undefined;
  const candidate = line.startsWith("SKILL_RESULT_JSON:")
    ? line.slice("SKILL_RESULT_JSON:".length).trim()
    : line;
  try {
    const parsed = JSON.parse(candidate) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const output = parsed as SkillScriptStructuredOutput;
    if (
      output.status === "ok" ||
      output.status === "error" ||
      "result" in output ||
      "logs" in output
    ) {
      return output;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function classifyScriptExecution(
  exec: SandboxExecResult,
  structuredOutput: SkillScriptStructuredOutput | undefined,
): SkillScriptExecutionOutcome {
  if (exec.timedOut) return "timed_out";
  if (structuredOutput?.status === "error") return "failed";
  if (exec.exitCode === 0 || structuredOutput?.status === "ok") return "succeeded";
  if (exec.exitCode === 2) return "invalid_arguments";
  return "failed";
}

function preview(value: string) {
  return value.length <= 512 ? value : `${value.slice(0, 512)}...`;
}

function createSkillTemplateName(label: string): string {
  return label
    .replace(/^skills\/[^/]+\/templates\//, "")
    .replace(/^skills\/.+\/templates\//, "")
    .replace(/\.[^.]+$/, "");
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
