import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import {
  createAgentResourceRegistry,
  type AgentResourceDefinition,
  type AgentResourceRegistry
} from "./resource-catalog.js";

/**
 * ResourceLoader 只处理“文本资源”的发现和读取。
 *
 * 这里的 kind 表示资源进入 agent 上下文前的语义分类，不表示执行能力。
 * 可执行工具即使也来自 agent/ 目录，也必须留在 tools/ 层，由 ToolRegistry /
 * ToolCatalog / ToolRuntime 负责。
 */
export type LoadedResourceKind =
  | "instruction"
  | "memory"
  | "reference";

export type LoadedResourceScope = "global" | "project" | "workspace" | "explicit";

/** 描述一个文本资源从哪里来；用于 diagnostics、debug UI 和审计，不直接渲染成 prompt。 */
export type LoadedResourceSourceInfo = {
  source: "file" | "sdk";
  label: string;
  path?: string;
  scope: LoadedResourceScope;
};

/**
 * ResourceLoader 的核心产物。
 *
 * 这条类型刻意保持可序列化：没有执行函数、没有闭包、没有运行期对象引用。
 * 后续 ResourceCatalog / PromptAssembler 可以安全地把它暴露给调试界面或写入快照。
 */
export type LoadedTextResource = {
  name: string;
  label: string;
  kind: LoadedResourceKind;
  content: string;
  sourceInfo: LoadedResourceSourceInfo;
  priority: number;
  loadedAt: string;
};

/** 资源加载阶段只收集诊断，不直接打印、不退出进程，由上层决定如何呈现或失败。 */
export type ResourceDiagnostic = {
  type: "warning" | "error";
  code:
    | "missing-root"
    | "read-failed"
    | "unsupported-entry"
    | "duplicate-resource";
  message: string;
  path?: string;
};

/** 一次资源加载的完整快照：文本资源 + 结构化诊断。 */
export type LoadedResourceSnapshot = {
  resources: readonly LoadedTextResource[];
  diagnostics: readonly ResourceDiagnostic[];
};

/** ResourceLoader 是一个窄接口，方便未来替换为数据库、远程包或测试 fake。 */
export type IResourceLoader = {
  load(): LoadedResourceSnapshot;
};

export type ResourceLoaderOptions = {
  /** Directory that contains agent/index.ts, resources/, skills/, and tools/. */
  agentDir: string;
  now?: () => Date;
};

type ResourceDirectory = {
  relativePath: string;
  kind: LoadedResourceKind;
  priority: number;
};

/**
 * 第一版应用目录约定。
 *
 * agent/tools 不在这里出现：tools 包含执行语义，不能混进可序列化文本资源层。
 * ResourceLoader 只扫描会进入上下文的 resources/ 文本资源。
 * prompt/templates、prompt/system、skills 和 tools 都有独立语义，不在这里加载。
 */
const RESOURCE_DIRECTORIES: readonly ResourceDirectory[] = [
  { relativePath: "resources/instructions", kind: "instruction", priority: 100 },
  { relativePath: "resources/memory", kind: "memory", priority: 200 },
  { relativePath: "resources/references", kind: "reference", priority: 300 }
];

const TEXT_EXTENSIONS = new Set([".md", ".txt"]);

/**
 * 从 agent 应用目录加载文本资源。
 *
 * 目录示例：
 *
 * ```text
 * agent/
 *   index.ts
 *   resources/
 *     instructions/
 *     memory/
 *     references/
 *   prompt/
 *     templates/
 *     system/
 *   skills/
 *   tools/
 * ```
 */
export class ResourceLoader implements IResourceLoader {
  private readonly agentDir: string;
  private readonly now: () => Date;

  constructor(options: ResourceLoaderOptions) {
    this.agentDir = resolve(options.agentDir);
    this.now = options.now ?? (() => new Date());
  }

  load(): LoadedResourceSnapshot {
    const diagnostics: ResourceDiagnostic[] = [];
    if (!existsSync(this.agentDir)) {
      return {
        resources: [],
        diagnostics: [{
          type: "error",
          code: "missing-root",
          message: `Agent resource root does not exist: ${this.agentDir}`,
          path: this.agentDir
        }]
      };
    }

    const resources: LoadedTextResource[] = [];
    for (const directory of RESOURCE_DIRECTORIES) {
      // 缺失目录表示该类资源未启用，不作为错误处理。
      const dirPath = join(this.agentDir, directory.relativePath);
      if (!existsSync(dirPath)) continue;
      resources.push(...this.loadDirectory(dirPath, directory, diagnostics));
    }

    return {
      resources: sortResources(resources, diagnostics),
      diagnostics
    };
  }

  /** 按目录约定发现资源，并把可直接进入 prompt 的文本资源注册成 ResourceRegistry。 */
  createRegistry(): AgentResourceRegistry {
    const snapshot = this.load();
    throwIfResourceLoadFailed(snapshot.diagnostics);
    return createAgentResourceRegistry(snapshot.resources
      .map(createAgentResourceDefinitionFromLoadedResource));
  }

  private loadDirectory(
    dirPath: string,
    directory: ResourceDirectory,
    diagnostics: ResourceDiagnostic[],
  ): LoadedTextResource[] {
    const stat = statSync(dirPath);
    if (!stat.isDirectory()) {
      diagnostics.push({
        type: "warning",
        code: "unsupported-entry",
        message: `Resource path is not a directory: ${dirPath}`,
        path: dirPath
      });
      return [];
    }

    return this.walk(dirPath, directory, diagnostics);
  }

  private walk(
    currentDir: string,
    directory: ResourceDirectory,
    diagnostics: ResourceDiagnostic[],
  ): LoadedTextResource[] {
    const resources: LoadedTextResource[] = [];
    const entries = readdirSync(currentDir, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const entryPath = join(currentDir, entry.name);
      // references 子目录也通过同一套递归规则处理。
      if (entry.isDirectory()) {
        resources.push(...this.walk(entryPath, directory, diagnostics));
        continue;
      }
      if (!entry.isFile()) {
        diagnostics.push({
          type: "warning",
          code: "unsupported-entry",
          message: `Resource entry is not a file: ${entryPath}`,
          path: entryPath
        });
        continue;
      }
      // 非文本文件保持沉默跳过，避免 images、fixtures 等旁路材料污染上下文。
      if (!isTextResourceFile(entry.name)) continue;
      const resource = this.loadFile(entryPath, directory, diagnostics);
      if (resource) resources.push(resource);
    }

    return resources;
  }

  private loadFile(
    filePath: string,
    directory: ResourceDirectory,
    diagnostics: ResourceDiagnostic[],
  ): LoadedTextResource | undefined {
    try {
      const content = readFileSync(filePath, "utf-8").trim();
      if (!content) return undefined;
      const relativePath = normalizePath(relative(this.agentDir, filePath));
      // name 使用 kind + 相对路径，避免不同目录里的同名文件互相覆盖。
      const name = createResourceName(directory.kind, relativePath);
      return {
        name,
        label: createResourceLabel(filePath),
        kind: directory.kind,
        content,
        sourceInfo: {
          source: "file",
          label: relativePath,
          path: filePath,
          scope: "project"
        },
        priority: directory.priority,
        loadedAt: this.now().toISOString()
      };
    } catch (error) {
      diagnostics.push({
        type: "error",
        code: "read-failed",
        message: `Could not read resource file: ${readErrorMessage(error)}`,
        path: filePath
      });
      return undefined;
    }
  }
}

function throwIfResourceLoadFailed(diagnostics: readonly ResourceDiagnostic[]) {
  const error = diagnostics.find((diagnostic) => diagnostic.type === "error");
  if (error) {
    throw new Error(error.message);
  }
}

function createAgentResourceDefinitionFromLoadedResource(
  resource: LoadedTextResource
): AgentResourceDefinition {
  return {
    name: resource.name,
    label: resource.label,
    kind: resource.kind,
    promptFragment: formatLoadedResourcePromptFragment(resource),
    sourceInfo: {
      source: resource.sourceInfo.source,
      label: resource.sourceInfo.label,
      ...(resource.sourceInfo.path ? { path: resource.sourceInfo.path } : {}),
      scope: resource.sourceInfo.scope
    }
  };
}

function formatLoadedResourcePromptFragment(resource: LoadedTextResource): string {
  const sourcePath = resource.sourceInfo.path ?? resource.sourceInfo.label;
  switch (resource.kind) {
    case "instruction":
      return `<project_instructions source="${sourcePath}">\n${resource.content}\n</project_instructions>`;
    case "memory":
      return `<memory_context source="${sourcePath}">\n${resource.content}\n</memory_context>`;
    case "reference":
      return `<reference_context source="${sourcePath}">\n${resource.content}\n</reference_context>`;
  }
}

function sortResources(
  resources: readonly LoadedTextResource[],
  diagnostics: ResourceDiagnostic[],
): readonly LoadedTextResource[] {
  const seen = new Set<string>();
  return [...resources]
    // priority 保证 instruction/memory/reference 的稳定顺序；
    // label 排序让同类资源跨平台保持可预测。
    .sort((left, right) =>
      left.priority - right.priority ||
      left.sourceInfo.label.localeCompare(right.sourceInfo.label)
    )
    .filter((resource) => {
      if (!seen.has(resource.name)) {
        seen.add(resource.name);
        return true;
      }
      diagnostics.push({
        type: "warning",
        code: "duplicate-resource",
        message: `Duplicate loaded resource skipped: ${resource.name}`,
        ...(resource.sourceInfo.path ? { path: resource.sourceInfo.path } : {})
      });
      return false;
    });
}

function isTextResourceFile(filename: string): boolean {
  return TEXT_EXTENSIONS.has(filename.slice(filename.lastIndexOf(".")).toLowerCase());
}

function createResourceName(kind: LoadedResourceKind, relativePath: string): string {
  return `${kind}:${relativePath.replace(/\.[^.]+$/, "")}`;
}

function createResourceLabel(filePath: string): string {
  return basename(filePath).replace(/\.[^.]+$/, "");
}

function normalizePath(path: string): string {
  return path.split("\\").join("/");
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
