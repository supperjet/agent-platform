import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createBuiltInToolDefinitions } from "./built-in/index.js";
import { createLocalToolOperations } from "./operations/index.js";
import {
  createAgentToolRegistry,
  type AgentToolRegistry,
  type AnyAgentToolDefinition
} from "./tool-registry.js";

export type ToolsLoaderOptions = {
  /** Directory that contains agent/index.ts, resources/, skills/, and tools/. */
  agentDir: string;
  /** Working directory used by built-in local tools. Defaults to process.cwd(). */
  workingDirectory?: string;
  /** Whether to include core built-in tools. Defaults to true. */
  includeBuiltInTools?: boolean;
};

export type LoadedToolsSnapshot = {
  tools: readonly AnyAgentToolDefinition[];
  diagnostics: readonly ToolsDiagnostic[];
};

export type ToolsDiagnostic = {
  type: "warning" | "error";
  code: "missing-tools-entry" | "invalid-tools-export" | "load-failed";
  message: string;
  path?: string;
};

/**
 * ToolsLoader 只负责从 agent/tools/index 导入工具定义，并生成 ToolRegistry。
 *
 * 工具定义包含 execute 闭包，所以它和 ResourceLoader 保持平行边界，不能混进
 * resource snapshot。
 */
export class ToolsLoader {
  private readonly agentDir: string;
  private readonly workingDirectory: string;
  private readonly includeBuiltInTools: boolean;

  constructor(options: ToolsLoaderOptions) {
    this.agentDir = resolve(options.agentDir);
    this.workingDirectory = resolve(options.workingDirectory ?? process.cwd());
    this.includeBuiltInTools = options.includeBuiltInTools ?? true;
  }

  async load(): Promise<LoadedToolsSnapshot> {
    const builtInTools = this.loadBuiltInTools();
    const toolsEntry = resolveToolsEntry(this.agentDir);
    if (!toolsEntry) {
      const expectedPath = join(this.agentDir, "tools", "index.js");
      return {
        tools: builtInTools,
        diagnostics: [{
          type: "warning",
          code: "missing-tools-entry",
          message: `Agent tools entry does not exist: ${expectedPath}`,
          path: expectedPath
        }]
      };
    }

    try {
      const module = await import(pathToFileURL(toolsEntry).href);
      const tools = readToolsExport(module);
      if (!tools) {
        return {
          tools: builtInTools,
          diagnostics: [{
            type: "error",
            code: "invalid-tools-export",
            message: `Agent tools entry must export a tools array: ${toolsEntry}`,
            path: toolsEntry
          }]
        };
      }
      return {
        tools: [
          ...builtInTools,
          ...tools
        ],
        diagnostics: []
      };
    } catch (error) {
      return {
        tools: builtInTools,
        diagnostics: [{
          type: "error",
          code: "load-failed",
          message: `Could not load agent tools: ${error instanceof Error ? error.message : String(error)}`,
          path: toolsEntry
        }]
      };
    }
  }

  async createRegistry(): Promise<AgentToolRegistry> {
    const snapshot = await this.load();
    throwIfToolsLoadFailed(snapshot.diagnostics);
    return createAgentToolRegistry(snapshot.tools);
  }

  private loadBuiltInTools(): readonly AnyAgentToolDefinition[] {
    if (!this.includeBuiltInTools) return [];
    return createBuiltInToolDefinitions(createLocalToolOperations({
      cwd: this.workingDirectory
    }));
  }
}

function throwIfToolsLoadFailed(diagnostics: readonly ToolsDiagnostic[]) {
  const error = diagnostics.find((diagnostic) => diagnostic.type === "error");
  if (error) {
    throw new Error(error.message);
  }
}

function resolveToolsEntry(agentDir: string): string | undefined {
  const directEntry = join(agentDir, "tools", "index.js");
  if (existsSync(directEntry)) return directEntry;

  const normalizedAgentDir = resolve(agentDir);
  const marker = "/src/";
  const markerIndex = normalizedAgentDir.indexOf(marker);
  if (markerIndex >= 0) {
    const distAgentDir = `${normalizedAgentDir.slice(0, markerIndex)}/dist/${normalizedAgentDir.slice(markerIndex + marker.length)}`;
    const distEntry = join(distAgentDir, "tools", "index.js");
    if (existsSync(distEntry)) return distEntry;
  }

  return undefined;
}

function readToolsExport(module: Record<string, unknown>): readonly AnyAgentToolDefinition[] | undefined {
  const candidate = module.tools ?? module.agentTools ?? module.default;
  if (!Array.isArray(candidate)) return undefined;
  return candidate as readonly AnyAgentToolDefinition[];
}
