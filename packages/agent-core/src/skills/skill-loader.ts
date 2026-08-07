import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import {
  parsePromptTemplateFile,
  renderPromptTemplate,
  type PromptTemplateDefinition,
  type RenderedPromptTemplate,
} from "../prompt/prompt-template.js";

export type SkillName = string;
export type SkillSourceScope = "global" | "project" | "workspace" | "explicit";

export type SkillSourceInfo = {
  source: "file" | "sdk";
  label: string;
  path?: string;
  scope: SkillSourceScope;
};

export type SkillSupportFileKind = "reference" | "template" | "script";

export type SkillSupportFileTrustPolicy = {
  canRead: boolean;
  canInject: boolean;
  canExecute: boolean;
  reason: string;
};

export type SkillScriptArgumentType =
  | "string"
  | "number"
  | "boolean"
  | "string[]"
  | "number[]"
  | "boolean[]"
  | "json";

export type SkillScriptArgumentDefinition = {
  name: string;
  type: SkillScriptArgumentType;
  required?: boolean;
  description?: string;
};

export type SkillScriptMetadata = {
  execute?: boolean;
  sandbox?: "virtual" | "local";
  interpreter?: "bash" | "node";
  timeoutMs?: number;
  outputLimitBytes?: number;
  args?: readonly SkillScriptArgumentDefinition[];
};

export type SkillSupportFile = {
  kind: SkillSupportFileKind;
  label: string;
  path: string;
  sourceInfo: SkillSourceInfo;
  trustPolicy?: SkillSupportFileTrustPolicy;
  script?: SkillScriptMetadata;
};

export type SkillSupportFileContent = {
  file: SkillSupportFile;
  content: string;
};

export type SkillTemplateMetadata = {
  name: string;
  description?: string;
  variableDefinitions?: PromptTemplateDefinition["variableDefinitions"];
};

export type SkillSupportFileManifestEntry = {
  kind: SkillSupportFileKind;
  label: string;
  sourceInfo: SkillSourceInfo;
  trustPolicy: SkillSupportFileTrustPolicy;
  script?: SkillScriptMetadata;
  template?: SkillTemplateMetadata;
};

/**
 * LoadedSkill 是可序列化的能力包描述。
 *
 * V1 只描述能力包和支持文件清单，不包含工具 execute 函数、脚本 runner 或其他运行期
 * 闭包。后续 activation 可以基于 sourceInfo 显式展开上下文。
 */
export type LoadedSkill = {
  name: SkillName;
  label: string;
  description?: string;
  disableModelInvocation?: boolean;
  instructions: string;
  sourceInfo: SkillSourceInfo;
  supportFiles: readonly SkillSupportFile[];
  priority: number;
  loadedAt: string;
};

export type SkillDiagnostic = {
  type: "warning" | "error";
  code:
    | "missing-root"
    | "read-failed"
    | "render-failed"
    | "trust-policy-denied"
    | "unsupported-entry"
    | "invalid-frontmatter"
    | "duplicate-skill";
  message: string;
  path?: string;
};

export type LoadedSkillSnapshot = {
  skills: readonly LoadedSkill[];
  diagnostics: readonly SkillDiagnostic[];
};

export type LoadedSkillSupportFileSnapshot = {
  files: readonly SkillSupportFileContent[];
  diagnostics: readonly SkillDiagnostic[];
};

export type SkillActivation = {
  name: SkillName;
  instructions: string;
  sourceInfo: SkillSourceInfo;
  arguments?: string;
  supportFiles?: readonly SkillSupportFileManifestEntry[];
  templates?: readonly RenderedPromptTemplate[];
  references?: readonly SkillSupportFileContent[];
  diagnostics?: readonly SkillDiagnostic[];
  disableModelInvocation?: boolean;
};

export type SkillRegistry = {
  getAllDefinitions(): readonly LoadedSkill[];
  getDefinition(name: SkillName): LoadedSkill | undefined;
  resolve(names: readonly SkillName[]): readonly LoadedSkill[];
};

export type SkillLoaderOptions = {
  /** Directory that contains agent/index.ts, resources/, prompt/, skills/, and tools/. */
  agentDir: string;
  now?: () => Date;
};

const SKILLS_DIRECTORY = "skills";
const SKILL_ENTRY_FILENAME = "SKILL.md";
const DEFAULT_SCRIPT_TIMEOUT_MS = 5_000;
const DEFAULT_SCRIPT_OUTPUT_LIMIT_BYTES = 1024 * 1024;
const SUPPORT_DIRECTORIES: Record<string, SkillSupportFileKind> = {
  references: "reference",
  templates: "template",
  scripts: "script",
};

export function defineSkill(definition: LoadedSkill): LoadedSkill {
  return normalizeSkillDefinition(definition);
}

export function createSkillRegistry(skills: readonly LoadedSkill[]): SkillRegistry {
  const definitionsByName = new Map<string, LoadedSkill>();

  for (const skill of skills) {
    const definition = normalizeSkillDefinition(skill);
    if (definitionsByName.has(definition.name)) {
      throw new Error(`SkillRegistry contains duplicate skill name: ${definition.name}`);
    }
    definitionsByName.set(definition.name, definition);
  }

  return {
    getAllDefinitions() {
      return [...definitionsByName.values()];
    },
    getDefinition(name) {
      return definitionsByName.get(normalizeSkillName("SkillRegistry.skillName", name));
    },
    resolve(names) {
      return names.map((name) => {
        const normalizedName = normalizeSkillName("SkillRegistry.skillNames[]", name);
        const skill = definitionsByName.get(normalizedName);
        if (!skill) {
          throw new Error(`SkillRegistry does not contain skill: ${normalizedName}`);
        }
        return skill;
      });
    },
  };
}

export function createDefaultSkillRegistry(): SkillRegistry {
  return createSkillRegistry([]);
}

export function readSkillSupportFiles(skill: LoadedSkill): LoadedSkillSupportFileSnapshot {
  return readSkillSupportFilesByKind(skill);
}

export function readSkillReferenceFiles(skill: LoadedSkill): LoadedSkillSupportFileSnapshot {
  return readSkillSupportFilesByKind(skill, ["reference"]);
}

export function readSkillTemplateFiles(skill: LoadedSkill): LoadedSkillSupportFileSnapshot {
  return readSkillSupportFilesByKind(skill, ["template"]);
}

export function resolveSkillSupportFileTrustPolicy(
  file: SkillSupportFile,
): SkillSupportFileTrustPolicy {
  return normalizeSupportFileTrustPolicy(file.kind, file.trustPolicy);
}

function readSkillSupportFilesByKind(
  skill: LoadedSkill,
  kinds?: readonly SkillSupportFileKind[],
): LoadedSkillSupportFileSnapshot {
  const files: SkillSupportFileContent[] = [];
  const diagnostics: SkillDiagnostic[] = [];
  const acceptedKinds = kinds ? new Set(kinds) : undefined;
  for (const file of skill.supportFiles.filter((file) => !acceptedKinds || acceptedKinds.has(file.kind))) {
    const trustPolicy = resolveSkillSupportFileTrustPolicy(file);
    if (!trustPolicy.canRead) {
      diagnostics.push({
        type: "warning",
        code: "trust-policy-denied",
        message: `Skill support file read denied by trust policy: ${trustPolicy.reason}`,
        path: file.path,
      });
      continue;
    }
    try {
      files.push({
        file,
        content: readFileSync(file.path, "utf-8"),
      });
    } catch (error) {
      diagnostics.push({
        type: "error",
        code: "read-failed",
        message: `Could not read skill support file: ${readErrorMessage(error)}`,
        path: file.path,
      });
    }
  }
  return { files, diagnostics };
}

export function activateSkill(
  skill: LoadedSkill,
  options: { arguments?: string; variables?: Record<string, string> } = {},
): SkillActivation {
  const referenceSnapshot = readSkillReferenceFiles(skill);
  const templateSnapshot = renderSkillTemplates(skill, options.variables ?? {});
  const diagnostics = [
    ...referenceSnapshot.diagnostics,
    ...templateSnapshot.diagnostics,
  ];
  return {
    name: skill.name,
    instructions: skill.instructions,
    sourceInfo: skill.sourceInfo,
    ...(options.arguments ? { arguments: options.arguments } : {}),
    ...(skill.supportFiles.length ? { supportFiles: createSkillSupportFileManifest(skill) } : {}),
    ...(referenceSnapshot?.files.length ? { references: referenceSnapshot.files } : {}),
    ...(templateSnapshot.templates.length ? { templates: templateSnapshot.templates } : {}),
    ...(diagnostics.length ? { diagnostics } : {}),
    ...(skill.disableModelInvocation === undefined
      ? {}
      : { disableModelInvocation: skill.disableModelInvocation }),
  };
}

function createSkillSupportFileManifest(
  skill: LoadedSkill,
): readonly SkillSupportFileManifestEntry[] {
  return skill.supportFiles.map((file) => ({
    kind: file.kind,
    label: file.label,
    sourceInfo: file.sourceInfo,
    trustPolicy: resolveSkillSupportFileTrustPolicy(file),
    ...(file.script ? { script: file.script } : {}),
    ...(file.kind === "template" ? createTemplateManifestEntry(file) : {}),
  }));
}

function createTemplateManifestEntry(
  file: SkillSupportFile,
): { template: SkillTemplateMetadata } | Record<string, never> {
  try {
    const parsed = parsePromptTemplateFile(readFileSync(file.path, "utf-8"));
    return {
      template: {
        name: createSkillTemplateName(file.sourceInfo.label),
        ...(parsed.metadata.description ? { description: parsed.metadata.description } : {}),
        ...(parsed.metadata.variableDefinitions
          ? { variableDefinitions: parsed.metadata.variableDefinitions }
          : {}),
      },
    };
  } catch {
    return {};
  }
}

function renderSkillTemplates(
  skill: LoadedSkill,
  variables: Record<string, string>,
): { templates: RenderedPromptTemplate[]; diagnostics: SkillDiagnostic[] } {
  const templateSnapshot = readSkillTemplateFiles(skill);
  const templates: RenderedPromptTemplate[] = [];
  const diagnostics: SkillDiagnostic[] = [...templateSnapshot.diagnostics];
  for (const file of templateSnapshot.files) {
    try {
      templates.push(renderPromptTemplate({
        template: createPromptTemplateFromSkillTemplate(skill, file),
        variables,
      }));
    } catch (error) {
      diagnostics.push({
        type: "error",
        code: "render-failed",
        message: `Could not render skill template ${file.file.sourceInfo.label}: ${readErrorMessage(error)}`,
        path: file.file.path,
      });
    }
  }
  return { templates, diagnostics };
}

function createPromptTemplateFromSkillTemplate(
  skill: LoadedSkill,
  file: SkillSupportFileContent,
): PromptTemplateDefinition {
  const parsed = parsePromptTemplateFile(file.content);
  return {
    name: createSkillTemplateName(file.file.sourceInfo.label),
    label: file.file.label.replace(/\.[^.]+$/, ""),
    ...parsed.metadata,
    content: parsed.content,
    sourceInfo: {
      source: file.file.sourceInfo.source,
      label: file.file.sourceInfo.label,
      ...(file.file.sourceInfo.path ? { path: file.file.sourceInfo.path } : {}),
      scope: file.file.sourceInfo.scope,
    },
    priority: skill.priority,
    loadedAt: skill.loadedAt,
  };
}

function createSkillTemplateName(label: string): string {
  return label
    .replace(/^skills\/[^/]+\/templates\//, "")
    .replace(/^skills\/.+\/templates\//, "")
    .replace(/\.[^.]+$/, "");
}

/**
 * 从 agent/skills 下的 SKILL.md 加载能力包描述。
 *
 * 缺失 skills 目录表示该 agent 没有声明 skill，不作为错误。缺失 agentDir 才表示
 * 装配入口不存在，需要向上层报告。
 */
export class SkillLoader {
  private readonly agentDir: string;
  private readonly now: () => Date;

  constructor(options: SkillLoaderOptions) {
    this.agentDir = resolve(options.agentDir);
    this.now = options.now ?? (() => new Date());
  }

  load(): LoadedSkillSnapshot {
    const diagnostics: SkillDiagnostic[] = [];
    if (!existsSync(this.agentDir)) {
      return {
        skills: [],
        diagnostics: [{
          type: "error",
          code: "missing-root",
          message: `Agent skill root does not exist: ${this.agentDir}`,
          path: this.agentDir,
        }],
      };
    }

    const dirPath = join(this.agentDir, SKILLS_DIRECTORY);
    if (!existsSync(dirPath)) {
      return { skills: [], diagnostics };
    }

    const stat = statPath(dirPath, diagnostics, "Skill path");
    if (!stat) {
      return { skills: [], diagnostics };
    }
    if (!stat.isDirectory()) {
      return {
        skills: [],
        diagnostics: [{
          type: "warning",
          code: "unsupported-entry",
          message: `Skill path is not a directory: ${dirPath}`,
          path: dirPath,
        }],
      };
    }

    return {
      skills: sortSkills(this.walk(dirPath, diagnostics), diagnostics),
      diagnostics,
    };
  }

  createRegistry(): SkillRegistry {
    const snapshot = this.load();
    throwIfSkillLoadFailed(snapshot.diagnostics);
    return createSkillRegistry(snapshot.skills);
  }

  private walk(
    currentDir: string,
    diagnostics: SkillDiagnostic[],
  ): LoadedSkill[] {
    const skills: LoadedSkill[] = [];
    const entries = readDirectoryEntries(currentDir, diagnostics);
    if (!entries) return skills;

    for (const entry of entries) {
      const entryPath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (isSkillSupportDirectory(currentDir, entry.name)) continue;
        skills.push(...this.walk(entryPath, diagnostics));
        continue;
      }
      if (!entry.isFile()) {
        diagnostics.push({
          type: "warning",
          code: "unsupported-entry",
          message: `Skill entry is not a file or directory: ${entryPath}`,
          path: entryPath,
        });
        continue;
      }
      if (entry.name !== SKILL_ENTRY_FILENAME) continue;
      const skill = this.loadSkillFile(entryPath, diagnostics);
      if (skill) skills.push(skill);
    }

    return skills;
  }

  private loadSkillFile(
    filePath: string,
    diagnostics: SkillDiagnostic[],
  ): LoadedSkill | undefined {
    try {
      const fileContent = readFileSync(filePath, "utf-8").trim();
      if (!fileContent) return undefined;
      const parsed = parseSkillFile(fileContent, filePath, diagnostics);
      if (!parsed) return undefined;
      if (!parsed.instructions) {
        diagnostics.push({
          type: "error",
          code: "invalid-frontmatter",
          message: `Skill file must contain instructions: ${filePath}`,
          path: filePath,
        });
        return undefined;
      }
      const relativePath = normalizePath(relative(this.agentDir, filePath));
      const skillDir = dirname(filePath);
      const defaultName = createSkillName(relativePath);
      const name = parsed.metadata.name ?? defaultName;
      return normalizeSkillDefinition({
        name,
        label: createSkillLabel(skillDir),
        ...(parsed.metadata.description ? { description: parsed.metadata.description } : {}),
        ...(parsed.metadata.disableModelInvocation === undefined
          ? {}
          : { disableModelInvocation: parsed.metadata.disableModelInvocation }),
        instructions: parsed.instructions,
        sourceInfo: {
          source: "file",
          label: relativePath,
          path: filePath,
          scope: "project",
        },
        supportFiles: this.loadSupportFiles(skillDir, diagnostics),
        priority: 100,
        loadedAt: this.now().toISOString(),
      });
    } catch (error) {
      diagnostics.push({
        type: "error",
        code: "read-failed",
        message: `Could not read skill file: ${readErrorMessage(error)}`,
        path: filePath,
      });
      return undefined;
    }
  }

  private loadSupportFiles(
    skillDir: string,
    diagnostics: SkillDiagnostic[],
  ): readonly SkillSupportFile[] {
    const files: SkillSupportFile[] = [];
    for (const [directoryName, kind] of Object.entries(SUPPORT_DIRECTORIES)) {
      const dirPath = join(skillDir, directoryName);
      if (!existsSync(dirPath)) continue;
      const supportPathStat = lstatPath(dirPath, diagnostics, "Skill support path");
      if (!supportPathStat) continue;
      if (supportPathStat.isSymbolicLink()) {
        diagnostics.push({
          type: "warning",
          code: "trust-policy-denied",
          message: `Skill support directory symlink is not trusted: ${dirPath}`,
          path: dirPath,
        });
        continue;
      }
      const stat = statPath(dirPath, diagnostics, "Skill support path");
      if (!stat) continue;
      if (!stat.isDirectory()) {
        diagnostics.push({
          type: "warning",
          code: "unsupported-entry",
          message: `Skill support path is not a directory: ${dirPath}`,
          path: dirPath,
        });
        continue;
      }
      files.push(...this.walkSupportFiles({
        currentDir: dirPath,
        skillDir,
        kind,
        diagnostics,
      }));
    }
    return files.sort((left, right) =>
      left.kind.localeCompare(right.kind) ||
      left.sourceInfo.label.localeCompare(right.sourceInfo.label)
    );
  }

  private walkSupportFiles(options: {
    currentDir: string;
    skillDir: string;
    kind: SkillSupportFileKind;
    diagnostics: SkillDiagnostic[];
  }): SkillSupportFile[] {
    const { currentDir, skillDir, kind, diagnostics } = options;
    const files: SkillSupportFile[] = [];
    const entries = readDirectoryEntries(currentDir, diagnostics);
    if (!entries) return files;

    for (const entry of entries) {
      const entryPath = join(currentDir, entry.name);
      if (entry.isSymbolicLink()) {
        diagnostics.push({
          type: "warning",
          code: "trust-policy-denied",
          message: `Skill support symlink is not trusted: ${entryPath}`,
          path: entryPath,
        });
        continue;
      }
      if (entry.isDirectory()) {
        files.push(...this.walkSupportFiles({
          currentDir: entryPath,
          skillDir,
          kind,
          diagnostics,
        }));
        continue;
      }
      if (!entry.isFile()) {
        diagnostics.push({
          type: "warning",
          code: "unsupported-entry",
          message: `Skill support entry is not a file: ${entryPath}`,
          path: entryPath,
        });
        continue;
      }
      const realEntryPath = realPath(entryPath, diagnostics);
      const realSkillDir = realPath(skillDir, diagnostics);
      if (!realEntryPath || !realSkillDir) continue;
      if (!isInsidePath(realEntryPath, realSkillDir)) {
        diagnostics.push({
          type: "warning",
          code: "trust-policy-denied",
          message: `Skill support file is outside the skill directory: ${entryPath}`,
          path: entryPath,
        });
        continue;
      }
      const relativePath = normalizePath(relative(this.agentDir, entryPath));
      const script = kind === "script"
        ? readSkillScriptMetadata(entryPath, diagnostics)
        : undefined;
      files.push({
        kind,
        label: basename(entryPath),
        path: entryPath,
        sourceInfo: {
          source: "file",
          label: relativePath,
          path: entryPath,
          scope: "project",
        },
        trustPolicy: createSupportFileTrustPolicy(kind, script),
        ...(script ? { script } : {}),
      });
    }

    return files;
  }
}

function throwIfSkillLoadFailed(diagnostics: readonly SkillDiagnostic[]) {
  const error = diagnostics.find((diagnostic) => diagnostic.type === "error");
  if (error) {
    throw new Error(error.message);
  }
}

function normalizeSkillDefinition(definition: LoadedSkill): LoadedSkill {
  const name = normalizeSkillName("Skill.name", definition.name);
  return {
    name,
    label: normalizeSkillText(`Skill.${name}.label`, definition.label),
    ...(definition.description
      ? { description: normalizeSkillText(`Skill.${name}.description`, definition.description) }
      : {}),
    ...(definition.disableModelInvocation === undefined
      ? {}
      : { disableModelInvocation: Boolean(definition.disableModelInvocation) }),
    instructions: normalizeSkillText(`Skill.${name}.instructions`, definition.instructions),
    sourceInfo: normalizeSourceInfo(name, definition.sourceInfo),
    supportFiles: definition.supportFiles.map((file) => normalizeSupportFile(name, file)),
    priority: normalizePriority(name, definition.priority),
    loadedAt: normalizeSkillText(`Skill.${name}.loadedAt`, definition.loadedAt),
  };
}

function normalizeSourceInfo(skillName: string, sourceInfo: SkillSourceInfo): SkillSourceInfo {
  const source = sourceInfo.source;
  if (source !== "file" && source !== "sdk") {
    throw new Error(`Skill.${skillName}.sourceInfo.source is invalid: ${String(source)}`);
  }
  if (!["global", "project", "workspace", "explicit"].includes(sourceInfo.scope)) {
    throw new Error(`Skill.${skillName}.sourceInfo.scope is invalid: ${String(sourceInfo.scope)}`);
  }
  return {
    source,
    label: normalizeSkillText(`Skill.${skillName}.sourceInfo.label`, sourceInfo.label),
    ...(sourceInfo.path ? { path: sourceInfo.path } : {}),
    scope: sourceInfo.scope,
  };
}

function normalizeSupportFile(skillName: string, file: SkillSupportFile): SkillSupportFile {
  if (!["reference", "template", "script"].includes(file.kind)) {
    throw new Error(`Skill.${skillName}.supportFiles[].kind is invalid: ${String(file.kind)}`);
  }
  return {
    kind: file.kind,
    label: normalizeSkillText(`Skill.${skillName}.supportFiles[].label`, file.label),
    path: normalizeSkillText(`Skill.${skillName}.supportFiles[].path`, file.path),
    sourceInfo: normalizeSourceInfo(skillName, file.sourceInfo),
    ...(file.trustPolicy
      ? { trustPolicy: normalizeSupportFileTrustPolicy(file.kind, file.trustPolicy) }
      : {}),
    ...(file.script ? { script: normalizeSkillScriptMetadata(skillName, file.script) } : {}),
  };
}

function normalizeSupportFileTrustPolicy(
  kind: SkillSupportFileKind,
  policy: SkillSupportFileTrustPolicy | undefined,
): SkillSupportFileTrustPolicy {
  if (!policy) return createSupportFileTrustPolicy(kind);
  return {
    canRead: Boolean(policy.canRead),
    canInject: Boolean(policy.canInject),
    canExecute: Boolean(policy.canExecute),
    reason: normalizeSkillText(`SkillSupportFile.${kind}.trustPolicy.reason`, policy.reason),
  };
}

function createSupportFileTrustPolicy(
  kind: SkillSupportFileKind,
  script?: SkillScriptMetadata,
): SkillSupportFileTrustPolicy {
  if (kind === "script") {
    if (script?.execute === true) {
      return {
        canRead: false,
        canInject: false,
        canExecute: true,
        reason: "scripts default to execute=yes unless frontmatter declares execute: false; SkillSupportRuntime may read it only for deterministic execution",
      };
    }
    if (script?.execute === false) {
      return {
        canRead: false,
        canInject: false,
        canExecute: false,
        reason: "script frontmatter declares execute: false",
      };
    }
    return {
      canRead: false,
      canInject: false,
      canExecute: false,
      reason: "scripts require SkillSupportRuntime and ToolRuntime approval before they can be read or executed",
    };
  }
  return {
    canRead: true,
    canInject: true,
    canExecute: false,
    reason: `${kind}s are trusted for read-only activation context when they stay inside the skill directory`,
  };
}

function normalizeSkillScriptMetadata(
  skillName: string,
  metadata: SkillScriptMetadata,
): SkillScriptMetadata {
  return {
    ...(metadata.execute === undefined ? {} : { execute: Boolean(metadata.execute) }),
    ...(metadata.sandbox === undefined ? {} : { sandbox: normalizeScriptSandbox(skillName, metadata.sandbox) }),
    ...(metadata.interpreter === undefined ? {} : { interpreter: normalizeScriptInterpreter(skillName, metadata.interpreter) }),
    ...(metadata.timeoutMs === undefined ? {} : { timeoutMs: normalizeNonNegativeInteger(`Skill.${skillName}.script.timeoutMs`, metadata.timeoutMs) }),
    ...(metadata.outputLimitBytes === undefined ? {} : { outputLimitBytes: normalizeNonNegativeInteger(`Skill.${skillName}.script.outputLimitBytes`, metadata.outputLimitBytes) }),
    ...(metadata.args === undefined ? {} : { args: normalizeScriptArgumentDefinitions(skillName, metadata.args) }),
  };
}

function normalizeScriptArgumentDefinitions(
  skillName: string,
  args: readonly SkillScriptArgumentDefinition[],
): readonly SkillScriptArgumentDefinition[] {
  const seen = new Set<string>();
  return args.map((arg, index) => {
    const name = normalizeScriptArgumentName(`Skill.${skillName}.script.args[${index}].name`, arg.name);
    if (seen.has(name)) {
      throw new Error(`Skill.${skillName}.script.args contains duplicate argument: ${name}`);
    }
    seen.add(name);
    return {
      name,
      type: normalizeScriptArgumentType(`Skill.${skillName}.script.args.${name}.type`, arg.type),
      ...(arg.required === undefined ? {} : { required: Boolean(arg.required) }),
      ...(arg.description === undefined ? {} : { description: normalizeSkillText(`Skill.${skillName}.script.args.${name}.description`, arg.description) }),
    };
  });
}

function normalizeScriptArgumentName(field: string, name: string): string {
  const normalized = normalizeSkillText(field, name);
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(normalized)) {
    throw new Error(`${field} must match [A-Za-z_][A-Za-z0-9_-]*.`);
  }
  return normalized;
}

function normalizeScriptArgumentType(field: string, type: string): SkillScriptArgumentType {
  if (isSkillScriptArgumentType(type)) return type;
  throw new Error(`${field} is invalid: ${type}`);
}

function isSkillScriptArgumentType(type: string): type is SkillScriptArgumentType {
  return [
    "string",
    "number",
    "boolean",
    "string[]",
    "number[]",
    "boolean[]",
    "json",
  ].includes(type);
}

function normalizeScriptSandbox(skillName: string, sandbox: string): "virtual" | "local" {
  if (sandbox !== "virtual" && sandbox !== "local") {
    throw new Error(`Skill.${skillName}.script.sandbox is invalid: ${sandbox}`);
  }
  return sandbox;
}

function normalizeScriptInterpreter(skillName: string, interpreter: string): "bash" | "node" {
  if (interpreter !== "bash" && interpreter !== "node") {
    throw new Error(`Skill.${skillName}.script.interpreter is invalid: ${interpreter}`);
  }
  return interpreter;
}

function normalizeNonNegativeInteger(field: string, value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer.`);
  }
  return value;
}

function normalizePriority(skillName: string, priority: number): number {
  if (!Number.isFinite(priority)) {
    throw new Error(`Skill.${skillName}.priority must be a finite number.`);
  }
  return priority;
}

function normalizeSkillName(field: string, name: SkillName): SkillName {
  const normalized = normalizeSkillText(field, name);
  if (!/^[A-Za-z_][A-Za-z0-9_/-]*$/.test(normalized)) {
    throw new Error(`${field} must match [A-Za-z_][A-Za-z0-9_/-]*.`);
  }
  return normalized;
}

function normalizeSkillText(field: string, value: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value.trim();
}

function sortSkills(
  skills: readonly LoadedSkill[],
  diagnostics: SkillDiagnostic[],
): readonly LoadedSkill[] {
  const seen = new Set<string>();
  return [...skills]
    .sort((left, right) =>
      left.priority - right.priority ||
      left.name.localeCompare(right.name)
    )
    .filter((skill) => {
      if (!seen.has(skill.name)) {
        seen.add(skill.name);
        return true;
      }
      diagnostics.push({
        type: "warning",
        code: "duplicate-skill",
        message: `Duplicate skill skipped: ${skill.name}`,
        ...(skill.sourceInfo.path ? { path: skill.sourceInfo.path } : {}),
      });
      return false;
    });
}

function createSkillName(relativePath: string): string {
  return dirname(relativePath)
    .replace(/^skills\//, "");
}

function createSkillLabel(skillDir: string): string {
  return basename(skillDir);
}

function isSkillSupportDirectory(currentDir: string, entryName: string): boolean {
  return entryName in SUPPORT_DIRECTORIES && existsSync(join(currentDir, SKILL_ENTRY_FILENAME));
}

function normalizePath(path: string): string {
  return path.split("\\").join("/");
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readSkillScriptMetadata(
  path: string,
  diagnostics: SkillDiagnostic[],
): SkillScriptMetadata | undefined {
  const inferredMetadata = inferSkillScriptMetadata(path);
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch (error) {
    diagnostics.push({
      type: "error",
      code: "read-failed",
      message: `Could not read skill script metadata: ${readErrorMessage(error)}`,
      path,
    });
    return inferredMetadata;
  }
  const frontmatter = readScriptFrontmatter(content);
  if (!frontmatter) return inferredMetadata;
  const metadata: SkillScriptMetadata = { ...inferredMetadata };
  for (const line of frontmatter.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const entry = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!entry?.[1]) {
      diagnostics.push({
        type: "error",
        code: "invalid-frontmatter",
        message: `Skill script frontmatter line is invalid: ${line.trim()}`,
        path,
      });
      return undefined;
    }
    const key = entry[1];
    const value = unquoteSkillValue(entry[2]?.trim() ?? "");
    if (key === "execute" || key === "trust_execute") {
      const booleanValue = parseSkillBoolean("Skill script execute", value, path, diagnostics);
      if (booleanValue === undefined) return undefined;
      metadata.execute = booleanValue;
      continue;
    }
    if (key === "sandbox") {
      if (value !== "virtual" && value !== "local") {
        diagnostics.push({
          type: "error",
          code: "invalid-frontmatter",
          message: `Skill script sandbox must be virtual or local: ${value}`,
          path,
        });
        return undefined;
      }
      metadata.sandbox = value;
      continue;
    }
    if (key === "interpreter") {
      if (value !== "bash" && value !== "node") {
        diagnostics.push({
          type: "error",
          code: "invalid-frontmatter",
          message: `Skill script interpreter must be bash or node: ${value}`,
          path,
        });
        return undefined;
      }
      metadata.interpreter = value;
      continue;
    }
    if (key === "timeout_ms" || key === "timeoutMs") {
      const timeoutMs = parseSkillNonNegativeInteger("Skill script timeout_ms", value, path, diagnostics);
      if (timeoutMs === undefined) return undefined;
      metadata.timeoutMs = timeoutMs;
      continue;
    }
    if (key === "output_limit_bytes" || key === "outputLimitBytes") {
      const outputLimitBytes = parseSkillNonNegativeInteger("Skill script output_limit_bytes", value, path, diagnostics);
      if (outputLimitBytes === undefined) return undefined;
      metadata.outputLimitBytes = outputLimitBytes;
      continue;
    }
    if (key.startsWith("arg_")) {
      const arg = parseSkillScriptArgumentDefinition(key.slice("arg_".length), value, path, diagnostics);
      if (!arg) return undefined;
      metadata.args = [...(metadata.args ?? []), arg];
      continue;
    }
  }
  return metadata;
}

function parseSkillScriptArgumentDefinition(
  name: string,
  value: string,
  path: string,
  diagnostics: SkillDiagnostic[],
): SkillScriptArgumentDefinition | undefined {
  const [rawType, rawRequired, ...descriptionParts] = value.split(/\s+/).filter(Boolean);
  if (!rawType) {
    diagnostics.push({
      type: "error",
      code: "invalid-frontmatter",
      message: `Skill script arg_${name} must declare a type.`,
      path,
    });
    return undefined;
  }
  const type = normalizeScriptArgumentTypeAlias(rawType);
  if (!type) {
    diagnostics.push({
      type: "error",
      code: "invalid-frontmatter",
      message: `Skill script arg_${name} type is invalid: ${rawType}`,
      path,
    });
    return undefined;
  }
  const required = rawRequired === "required"
    ? true
    : rawRequired === "optional"
      ? false
      : undefined;
  const description = required === undefined
    ? [rawRequired, ...descriptionParts].filter(Boolean).join(" ")
    : descriptionParts.join(" ");
  return {
    name,
    type,
    ...(required === undefined ? {} : { required }),
    ...(description ? { description: unquoteSkillValue(description) } : {}),
  };
}

function normalizeScriptArgumentTypeAlias(type: string): SkillScriptArgumentType | undefined {
  const normalized = type
    .replace(/^array<(.+)>$/, "$1[]")
    .replace("integer", "number")
    .replace("bool", "boolean");
  return isSkillScriptArgumentType(normalized) ? normalized : undefined;
}

function inferSkillScriptMetadata(path: string): SkillScriptMetadata | undefined {
  const extension = extname(path).toLowerCase();
  if (extension === ".sh" || extension === ".bash") {
    return {
      execute: true,
      sandbox: "virtual",
      interpreter: "bash",
      timeoutMs: DEFAULT_SCRIPT_TIMEOUT_MS,
      outputLimitBytes: DEFAULT_SCRIPT_OUTPUT_LIMIT_BYTES,
    };
  }
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") {
    return {
      execute: true,
      sandbox: "local",
      interpreter: "node",
      timeoutMs: DEFAULT_SCRIPT_TIMEOUT_MS,
      outputLimitBytes: DEFAULT_SCRIPT_OUTPUT_LIMIT_BYTES,
    };
  }
  return undefined;
}

function readScriptFrontmatter(content: string): string | undefined {
  const plain = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (plain) return plain[1] ?? "";
  const blockComment = content.match(/^\/\*---\r?\n([\s\S]*?)\r?\n---\*\/(?:\r?\n|$)/);
  if (blockComment) return blockComment[1] ?? "";
  return undefined;
}

function parseSkillBoolean(
  label: string,
  value: string,
  path: string,
  diagnostics: SkillDiagnostic[],
): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  diagnostics.push({
    type: "error",
    code: "invalid-frontmatter",
    message: `${label} must be true or false: ${value}`,
    path,
  });
  return undefined;
}

function parseSkillNonNegativeInteger(
  label: string,
  value: string,
  path: string,
  diagnostics: SkillDiagnostic[],
): number | undefined {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  diagnostics.push({
    type: "error",
    code: "invalid-frontmatter",
    message: `${label} must be a non-negative integer: ${value}`,
    path,
  });
  return undefined;
}

function statPath(
  path: string,
  diagnostics: SkillDiagnostic[],
  label: string,
) {
  try {
    return statSync(path);
  } catch (error) {
    diagnostics.push({
      type: "error",
      code: "read-failed",
      message: `${label} could not be inspected: ${readErrorMessage(error)}`,
      path,
    });
    return undefined;
  }
}

function lstatPath(
  path: string,
  diagnostics: SkillDiagnostic[],
  label: string,
) {
  try {
    return lstatSync(path);
  } catch (error) {
    diagnostics.push({
      type: "error",
      code: "read-failed",
      message: `${label} could not be inspected: ${readErrorMessage(error)}`,
      path,
    });
    return undefined;
  }
}

function realPath(
  path: string,
  diagnostics: SkillDiagnostic[],
) {
  try {
    return realpathSync(path);
  } catch (error) {
    diagnostics.push({
      type: "error",
      code: "read-failed",
      message: `Skill support path could not be resolved: ${readErrorMessage(error)}`,
      path,
    });
    return undefined;
  }
}

function isInsidePath(path: string, rootPath: string): boolean {
  const relativePath = relative(rootPath, path);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function readDirectoryEntries(
  path: string,
  diagnostics: SkillDiagnostic[],
) {
  try {
    return readdirSync(path, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch (error) {
    diagnostics.push({
      type: "error",
      code: "read-failed",
      message: `Could not read skill directory: ${readErrorMessage(error)}`,
      path,
    });
    return undefined;
  }
}

type ParsedSkillFrontmatter = {
  name?: string;
  description?: string;
  disableModelInvocation?: boolean;
};

function parseSkillFile(
  fileContent: string,
  filePath: string,
  diagnostics: SkillDiagnostic[],
): { metadata: ParsedSkillFrontmatter; instructions: string } | undefined {
  if (fileContent.startsWith("---")) {
    const match = fileContent.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!match) {
      diagnostics.push({
        type: "error",
        code: "invalid-frontmatter",
        message: `Skill frontmatter is missing a closing delimiter: ${filePath}`,
        path: filePath,
      });
      return undefined;
    }
    const metadata = parseSkillFrontmatter(match[1] ?? "", filePath, diagnostics);
    if (!metadata) return undefined;
    return {
      metadata,
      instructions: fileContent.slice(match[0].length).trim(),
    };
  }

  return {
    metadata: {},
    instructions: fileContent.trim(),
  };
}

function parseSkillFrontmatter(
  frontmatter: string,
  filePath: string,
  diagnostics: SkillDiagnostic[],
): ParsedSkillFrontmatter | undefined {
  const metadata: ParsedSkillFrontmatter = {};
  for (const line of frontmatter.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!match?.[1]) {
      diagnostics.push({
        type: "error",
        code: "invalid-frontmatter",
        message: `Skill frontmatter line is invalid: ${line.trim()}`,
        path: filePath,
      });
      return undefined;
    }

    const key = match[1];
    const value = unquoteSkillValue(match[2]?.trim() ?? "");
    if (key === "name") {
      if (!isValidSkillName(value)) {
        diagnostics.push({
          type: "error",
          code: "invalid-frontmatter",
          message: `Skill name is invalid: ${value}`,
          path: filePath,
        });
        return undefined;
      }
      metadata.name = value;
      continue;
    }
    if (key === "description") {
      if (!value) {
        diagnostics.push({
          type: "error",
          code: "invalid-frontmatter",
          message: "Skill description must be a non-empty string.",
          path: filePath,
        });
        return undefined;
      }
      metadata.description = value;
      continue;
    }
    if (key === "disable_model_invocation" || key === "disable-model-invocation") {
      if (value !== "true" && value !== "false") {
        diagnostics.push({
          type: "error",
          code: "invalid-frontmatter",
          message: `Skill disable_model_invocation must be true or false: ${value}`,
          path: filePath,
        });
        return undefined;
      }
      const disableModelInvocation = value === "true";
      if (
        metadata.disableModelInvocation !== undefined &&
        metadata.disableModelInvocation !== disableModelInvocation
      ) {
        diagnostics.push({
          type: "error",
          code: "invalid-frontmatter",
          message: "Skill disable_model_invocation is declared with conflicting values.",
          path: filePath,
        });
        return undefined;
      }
      metadata.disableModelInvocation = disableModelInvocation;
    }
  }
  return metadata;
}

function unquoteSkillValue(value: string): string {
  const quote = value[0];
  if ((quote === "\"" || quote === "'") && value.endsWith(quote)) {
    return value.slice(1, -1);
  }
  return value;
}

function isValidSkillName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_/-]*$/.test(value);
}
