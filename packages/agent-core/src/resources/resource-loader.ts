import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";

export type LoadedResourceKind =
  | "instruction"
  | "memory"
  | "skill"
  | "prompt-template"
  | "reference"
  | "system-prompt"
  | "append-system-prompt";

export type LoadedResourceScope = "global" | "project" | "workspace" | "explicit";

export type LoadedResourceSourceInfo = {
  source: "file" | "sdk";
  label: string;
  path?: string;
  scope: LoadedResourceScope;
};

export type LoadedTextResource = {
  name: string;
  label: string;
  kind: LoadedResourceKind;
  content: string;
  sourceInfo: LoadedResourceSourceInfo;
  priority: number;
  loadedAt: string;
};

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

export type LoadedResourceSnapshot = {
  resources: readonly LoadedTextResource[];
  diagnostics: readonly ResourceDiagnostic[];
};

export type ResourceLoader = {
  load(): LoadedResourceSnapshot;
};

export type AgentAppResourceLoaderOptions = {
  /** Directory that contains agent/index.ts, resources/, skills/, and tools/. */
  agentDir: string;
  now?: () => Date;
};

type ResourceDirectory = {
  relativePath: string;
  kind: LoadedResourceKind;
  priority: number;
};

const RESOURCE_DIRECTORIES: readonly ResourceDirectory[] = [
  { relativePath: "resources/instructions", kind: "instruction", priority: 100 },
  { relativePath: "resources/memory", kind: "memory", priority: 200 },
  { relativePath: "resources/references", kind: "reference", priority: 300 },
  { relativePath: "resources/prompt-templates", kind: "prompt-template", priority: 400 },
  { relativePath: "skills", kind: "skill", priority: 500 }
];

const TEXT_EXTENSIONS = new Set([".md", ".txt"]);

export class AgentAppResourceLoader implements ResourceLoader {
  private readonly agentDir: string;
  private readonly now: () => Date;

  constructor(options: AgentAppResourceLoaderOptions) {
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
      const dirPath = join(this.agentDir, directory.relativePath);
      if (!existsSync(dirPath)) continue;
      resources.push(...this.loadDirectory(dirPath, directory, diagnostics));
    }

    return {
      resources: sortResources(resources, diagnostics),
      diagnostics
    };
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

function sortResources(
  resources: readonly LoadedTextResource[],
  diagnostics: ResourceDiagnostic[],
): readonly LoadedTextResource[] {
  const seen = new Set<string>();
  return [...resources]
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
