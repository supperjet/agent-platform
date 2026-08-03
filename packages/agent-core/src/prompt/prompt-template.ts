import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";

export type PromptTemplateName = string;
export type PromptTemplateScope = "global" | "project" | "workspace" | "explicit";

export type PromptTemplateSourceInfo = {
  source: "file" | "sdk";
  label: string;
  path?: string;
  scope: PromptTemplateScope;
};

/**
 * PromptTemplate 是“任务输入模板”，不是长期上下文资源。
 *
 * 它可以在某次任务开始前被 slash command、workflow 或宿主 UI 选中，然后渲染成
 * user prompt / run-level instruction。它不会进入 ResourceCatalog，也不会自动
 * 注入 base system prompt。
 */
export type PromptTemplateDefinition = {
  name: PromptTemplateName;
  label: string;
  content: string;
  sourceInfo: PromptTemplateSourceInfo;
  priority: number;
  loadedAt?: string;
};

export type PromptTemplateDiagnostic = {
  type: "warning" | "error";
  code:
    | "missing-root"
    | "read-failed"
    | "unsupported-entry"
    | "duplicate-template";
  message: string;
  path?: string;
};

export type LoadedPromptTemplateSnapshot = {
  templates: readonly PromptTemplateDefinition[];
  diagnostics: readonly PromptTemplateDiagnostic[];
};

export type PromptTemplateRegistry = {
  getAllDefinitions(): readonly PromptTemplateDefinition[];
  getDefinition(name: PromptTemplateName): PromptTemplateDefinition | undefined;
  resolve(names: readonly PromptTemplateName[]): readonly PromptTemplateDefinition[];
};

export type PromptTemplateLoaderOptions = {
  /** Directory that contains agent/index.ts, prompt/, resources/, skills/, and tools/. */
  agentDir: string;
  now?: () => Date;
};

const TEMPLATE_DIRECTORY = "prompt/templates";
const TEXT_EXTENSIONS = new Set([".md", ".txt"]);

export function definePromptTemplate(
  definition: PromptTemplateDefinition,
): PromptTemplateDefinition {
  return normalizePromptTemplateDefinition(definition);
}

export function createPromptTemplateRegistry(
  templates: readonly PromptTemplateDefinition[],
): PromptTemplateRegistry {
  const definitionsByName = new Map<string, PromptTemplateDefinition>();

  for (const template of templates) {
    const definition = normalizePromptTemplateDefinition(template);
    if (definitionsByName.has(definition.name)) {
      throw new Error(`PromptTemplateRegistry contains duplicate template name: ${definition.name}`);
    }
    definitionsByName.set(definition.name, definition);
  }

  return {
    getAllDefinitions() {
      return [...definitionsByName.values()];
    },
    getDefinition(name) {
      return definitionsByName.get(normalizeTemplateName("PromptTemplateRegistry.templateName", name));
    },
    resolve(names) {
      return names.map((name) => {
        const normalizedName = normalizeTemplateName("PromptTemplateRegistry.templateNames[]", name);
        const template = definitionsByName.get(normalizedName);
        if (!template) {
          throw new Error(`PromptTemplateRegistry does not contain template: ${normalizedName}`);
        }
        return template;
      });
    },
  };
}

export function createDefaultPromptTemplateRegistry(): PromptTemplateRegistry {
  return createPromptTemplateRegistry([]);
}

/**
 * 从 agent/prompt/templates 加载 prompt 模板。
 *
 * 缺失 templates 目录表示应用没有模板，不作为错误。缺失 agentDir 才表示装配入口
 * 不存在，需要向上层报告。
 */
export class PromptTemplateLoader {
  private readonly agentDir: string;
  private readonly now: () => Date;

  constructor(options: PromptTemplateLoaderOptions) {
    this.agentDir = resolve(options.agentDir);
    this.now = options.now ?? (() => new Date());
  }

  load(): LoadedPromptTemplateSnapshot {
    const diagnostics: PromptTemplateDiagnostic[] = [];
    if (!existsSync(this.agentDir)) {
      return {
        templates: [],
        diagnostics: [{
          type: "error",
          code: "missing-root",
          message: `Agent prompt template root does not exist: ${this.agentDir}`,
          path: this.agentDir,
        }],
      };
    }

    const dirPath = join(this.agentDir, TEMPLATE_DIRECTORY);
    if (!existsSync(dirPath)) {
      return { templates: [], diagnostics };
    }

    const stat = statSync(dirPath);
    if (!stat.isDirectory()) {
      return {
        templates: [],
        diagnostics: [{
          type: "warning",
          code: "unsupported-entry",
          message: `Prompt template path is not a directory: ${dirPath}`,
          path: dirPath,
        }],
      };
    }

    return {
      templates: sortTemplates(this.walk(dirPath, diagnostics), diagnostics),
      diagnostics,
    };
  }

  createRegistry(): PromptTemplateRegistry {
    const snapshot = this.load();
    throwIfPromptTemplateLoadFailed(snapshot.diagnostics);
    return createPromptTemplateRegistry(snapshot.templates);
  }

  private walk(
    currentDir: string,
    diagnostics: PromptTemplateDiagnostic[],
  ): PromptTemplateDefinition[] {
    const templates: PromptTemplateDefinition[] = [];
    const entries = readdirSync(currentDir, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const entryPath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        templates.push(...this.walk(entryPath, diagnostics));
        continue;
      }
      if (!entry.isFile()) {
        diagnostics.push({
          type: "warning",
          code: "unsupported-entry",
          message: `Prompt template entry is not a file: ${entryPath}`,
          path: entryPath,
        });
        continue;
      }
      if (!isTextTemplateFile(entry.name)) continue;
      const template = this.loadFile(entryPath, diagnostics);
      if (template) templates.push(template);
    }

    return templates;
  }

  private loadFile(
    filePath: string,
    diagnostics: PromptTemplateDiagnostic[],
  ): PromptTemplateDefinition | undefined {
    try {
      const content = readFileSync(filePath, "utf-8").trim();
      if (!content) return undefined;
      const relativePath = normalizePath(relative(this.agentDir, filePath));
      const name = createTemplateName(relativePath);
      return {
        name,
        label: createTemplateLabel(filePath),
        content,
        sourceInfo: {
          source: "file",
          label: relativePath,
          path: filePath,
          scope: "project",
        },
        priority: 100,
        loadedAt: this.now().toISOString(),
      };
    } catch (error) {
      diagnostics.push({
        type: "error",
        code: "read-failed",
        message: `Could not read prompt template file: ${readErrorMessage(error)}`,
        path: filePath,
      });
      return undefined;
    }
  }
}

function throwIfPromptTemplateLoadFailed(
  diagnostics: readonly PromptTemplateDiagnostic[],
) {
  const error = diagnostics.find((diagnostic) => diagnostic.type === "error");
  if (error) {
    throw new Error(error.message);
  }
}

function normalizePromptTemplateDefinition(
  definition: PromptTemplateDefinition,
): PromptTemplateDefinition {
  const name = normalizeTemplateName("PromptTemplate.name", definition.name);
  return {
    name,
    label: normalizeTemplateText(`PromptTemplate.${name}.label`, definition.label),
    content: normalizeTemplateText(`PromptTemplate.${name}.content`, definition.content),
    sourceInfo: normalizeSourceInfo(name, definition.sourceInfo),
    priority: normalizePriority(name, definition.priority),
    ...(definition.loadedAt ? { loadedAt: definition.loadedAt } : {}),
  };
}

function normalizeSourceInfo(
  templateName: string,
  sourceInfo: PromptTemplateSourceInfo,
): PromptTemplateSourceInfo {
  const source = sourceInfo.source;
  if (source !== "file" && source !== "sdk") {
    throw new Error(`PromptTemplate.${templateName}.sourceInfo.source is invalid: ${String(source)}`);
  }
  return {
    source,
    label: normalizeTemplateText(`PromptTemplate.${templateName}.sourceInfo.label`, sourceInfo.label),
    ...(sourceInfo.path ? { path: sourceInfo.path } : {}),
    scope: sourceInfo.scope,
  };
}

function normalizeTemplateName(field: string, name: PromptTemplateName): PromptTemplateName {
  return normalizeTemplateText(field, name);
}

function normalizeTemplateText(field: string, value: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value.trim();
}

function normalizePriority(templateName: string, priority: number): number {
  if (!Number.isFinite(priority)) {
    throw new Error(`PromptTemplate.${templateName}.priority must be a finite number.`);
  }
  return priority;
}

function sortTemplates(
  templates: readonly PromptTemplateDefinition[],
  diagnostics: PromptTemplateDiagnostic[],
): readonly PromptTemplateDefinition[] {
  const seen = new Set<string>();
  return [...templates]
    .sort((left, right) =>
      left.priority - right.priority ||
      left.name.localeCompare(right.name)
    )
    .filter((template) => {
      if (!seen.has(template.name)) {
        seen.add(template.name);
        return true;
      }
      diagnostics.push({
        type: "warning",
        code: "duplicate-template",
        message: `Duplicate prompt template skipped: ${template.name}`,
        ...(template.sourceInfo.path ? { path: template.sourceInfo.path } : {}),
      });
      return false;
    });
}

function isTextTemplateFile(filename: string): boolean {
  return TEXT_EXTENSIONS.has(filename.slice(filename.lastIndexOf(".")).toLowerCase());
}

function createTemplateName(relativePath: string): string {
  return relativePath
    .replace(/^prompt\/templates\//, "")
    .replace(/\.[^.]+$/, "");
}

function createTemplateLabel(filePath: string): string {
  return basename(filePath).replace(/\.[^.]+$/, "");
}

function normalizePath(path: string): string {
  return path.split("\\").join("/");
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
