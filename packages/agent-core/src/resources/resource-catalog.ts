import type { AgentResourceName } from "../definition/agent-definition.js";
import type { ResolvedAgentDefinition } from "../definition/definition-resolver.js";
import type {
  LoadedResourceKind,
  LoadedTextResource,
  ResourceDiagnostic,
} from "./resource-loader.js";

/**
 * ResourceCatalog 对外暴露的来源信息。
 *
 * registry 资源和文件资源最终都会被规范化成这类安全 metadata。这里不包含资源
 * 内容本身，也不包含任何执行闭包，适合给 API/debug UI 展示。
 */
export type AgentResourceSourceInfo = {
  source: "builtin" | "registry" | "sdk" | "extension" | "file";
  label: string;
  path?: string;
  scope?: string;
};

export type AgentResourceDefinition = {
  name: AgentResourceName;
  label: string;
  kind?: LoadedResourceKind;
  /** 静态 registry 资源被启用时注入 prompt 的文本片段。 */
  promptFragment: string;
  /** Catalog/debug metadata 描述资源来源；不直接渲染成 prompt 文本。 */
  sourceInfo: AgentResourceSourceInfo;
};

/** ResourceCatalog 内部使用的规范化条目，保留 prompt 片段和安全来源信息。 */
export type ResourceCatalogEntry = {
  name: AgentResourceName;
  label: string;
  kind?: LoadedResourceKind;
  promptFragment: string;
  sourceInfo: AgentResourceSourceInfo;
};

/** 面向公开 API/debug 的安全视图，不包含 promptFragment 内容。 */
export type ResourceCatalogResourceInfo = {
  name: AgentResourceName;
  label: string;
  kind?: LoadedResourceKind;
  sourceInfo: AgentResourceSourceInfo;
};

/** 解析一次 active resources 后得到的全部投影。 */
export type ResourceCatalogResolution = {
  resourceNames: readonly AgentResourceName[];
  entries: readonly ResourceCatalogEntry[];
  resourceInfos: readonly ResourceCatalogResourceInfo[];
  promptFragments: readonly string[];
};

/**
 * RuntimeAssembler 消费的资源快照。
 *
 * - promptFragments 进入 PromptAssembler。
 * - resourceInfos / diagnostics 可用于 UI、日志和调试。
 * - loadedResources / diagnostics 预留给上层把 loader 诊断并入 debug surface。
 */
export type ResourceSnapshot = ResourceCatalogResolution & {
  contextFilePaths: readonly string[];
  skillNames: readonly string[];
  loadedResources: readonly LoadedTextResource[];
  diagnostics: readonly ResourceDiagnostic[];
};

export type ResourceCatalogLoadInput = {
  sessionId: string;
  definition: ResolvedAgentDefinition;
};

export type AgentResourceRegistry = {
  resolve(names: readonly AgentResourceName[]): readonly AgentResourceDefinition[];
  getAllDefinitions(): readonly AgentResourceDefinition[];
  getDefinition(name: AgentResourceName): AgentResourceDefinition | undefined;
};

export function defineAgentResource(definition: AgentResourceDefinition): AgentResourceDefinition {
  return definition;
}

export function createAgentResourceRegistry(
  resources: readonly AgentResourceDefinition[]
): AgentResourceRegistry {
  const definitionsByName = new Map<string, AgentResourceDefinition>();

  for (const resource of resources) {
    const name = normalizeSingleResourceName("AgentResourceRegistry.resources[].name", resource.name);
    if (definitionsByName.has(name)) {
      throw new Error(`AgentResourceRegistry contains duplicate resource name: ${name}`);
    }
    definitionsByName.set(name, resource);
  }

  return {
    resolve(names) {
      return names.map((name) => {
        const normalizedName = normalizeSingleResourceName("AgentDefinition.resourceNames[]", name);
        const resource = definitionsByName.get(normalizedName);
        if (!resource) {
          throw new Error(`AgentResourceRegistry does not contain resource: ${normalizedName}`);
        }
        return resource;
      });
    },
    getAllDefinitions() {
      return [...definitionsByName.values()];
    },
    getDefinition(name) {
      return definitionsByName.get(normalizeSingleResourceName("ResourceCatalog.resourceName", name));
    }
  };
}

export function createDefaultAgentResourceRegistry(): AgentResourceRegistry {
  return createAgentResourceRegistry([]);
}

/**
 * ResourceCatalog 负责把 ResourceRegistry 投影成 prompt/debug 可消费的形态。
 *
 * 它不读文件、不扫描目录，也不理解工具执行；文件发现属于 ResourceLoader，
 * ResourceLoader 会先生成 registry，可执行能力属于 tools/。
 */
export class ResourceCatalog {
  constructor(
    private readonly registry: AgentResourceRegistry = createDefaultAgentResourceRegistry(),
  ) {}

  load(input: ResourceCatalogLoadInput): ResourceSnapshot {
    const resolution = this.resolveForDefinition(input.definition);
    return {
      ...resolution,
      contextFilePaths: resolution.entries.flatMap((entry) =>
        entry.sourceInfo.path ? [entry.sourceInfo.path] : []
      ),
      skillNames: resolution.entries.flatMap((entry) =>
        entry.kind === "skill" ? [entry.name] : []
      ),
      loadedResources: [],
      diagnostics: []
    };
  }

  resolve(names: readonly AgentResourceName[]): readonly string[] {
    return this.resolvePlan({ resourceNames: names }).promptFragments;
  }

  resolveForDefinition(definition: ResolvedAgentDefinition): ResourceCatalogResolution {
    return this.resolvePlan({
      definition,
      resourceNames: definition.resourceNames
    });
  }

  getAllResources(): readonly ResourceCatalogEntry[] {
    return this.registry.getAllDefinitions().map(createCatalogEntry);
  }

  getAllResourceInfos(): readonly ResourceCatalogResourceInfo[] {
    return this.getAllResources().map(toResourceInfo);
  }

  getResourceDefinition(name: AgentResourceName): ResourceCatalogEntry | undefined {
    const definition = this.registry.getDefinition(name);
    if (!definition) return undefined;
    return createCatalogEntry(definition);
  }

  getResourceInfo(name: AgentResourceName): ResourceCatalogResourceInfo | undefined {
    const entry = this.getResourceDefinition(name);
    if (!entry) return undefined;
    return toResourceInfo(entry);
  }

  resolvePlan(input: {
    definition?: ResolvedAgentDefinition;
    resourceNames: readonly AgentResourceName[];
  }): ResourceCatalogResolution {
    const resourceNames = normalizeResourceNames(input.resourceNames);
    const definitions = this.registry.resolve(resourceNames);
    const entries = definitions.map((definition, index) => {
      const resourceName = resourceNames[index];
      if (!resourceName) {
        throw new Error(`ResourceCatalog resolved unexpected resource at index: ${index}`);
      }
      assertResourceNameMatchesRequest(resourceName, definition);
      return createCatalogEntry(definition);
    });

    return {
      resourceNames,
      entries,
      resourceInfos: entries.map(toResourceInfo),
      promptFragments: entries.map((entry) => entry.promptFragment)
    };
  }
}

function createCatalogEntry(definition: AgentResourceDefinition): ResourceCatalogEntry {
  const name = normalizeSingleResourceName("AgentResource.name", definition.name);
  return {
    name,
    label: normalizeResourceText(`AgentResource.${name}.label`, definition.label),
    ...(definition.kind ? { kind: definition.kind } : {}),
    promptFragment: normalizeResourcePromptFragment(name, definition.promptFragment),
    sourceInfo: normalizeSourceInfo(name, definition.sourceInfo)
  };
}

function toResourceInfo(entry: ResourceCatalogEntry): ResourceCatalogResourceInfo {
  return {
    name: entry.name,
    label: entry.label,
    ...(entry.kind ? { kind: entry.kind } : {}),
    sourceInfo: entry.sourceInfo
  };
}

function normalizeResourceNames(names: readonly AgentResourceName[]): readonly AgentResourceName[] {
  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const name of names) {
    const normalizedName = normalizeSingleResourceName("ResourceCatalog.resourceNames[]", name);
    if (seen.has(normalizedName)) {
      throw new Error(`ResourceCatalog.resourceNames contains duplicate resource name: ${normalizedName}`);
    }
    seen.add(normalizedName);
    normalized.push(normalizedName);
  }

  return normalized;
}

function normalizeSingleResourceName(field: string, name: AgentResourceName): AgentResourceName {
  assertNonBlank(field, name);
  return name.trim();
}

function assertResourceNameMatchesRequest(
  requestedName: AgentResourceName,
  definition: AgentResourceDefinition
) {
  const resolvedName = normalizeSingleResourceName(`AgentResource.${requestedName}.name`, definition.name);
  if (resolvedName !== requestedName) {
    throw new Error(`ResourceCatalog resolved ${requestedName} to mismatched resource: ${resolvedName}`);
  }
}

function normalizeResourceText(field: string, value: string) {
  assertNonBlank(field, value);
  return value.trim();
}

function normalizeResourcePromptFragment(resourceName: string, value: string) {
  assertNonBlank(`AgentResource.${resourceName}.promptFragment`, value);
  return value.trim();
}

function normalizeSourceInfo(resourceName: string, sourceInfo: AgentResourceSourceInfo): AgentResourceSourceInfo {
  if (!sourceInfo || typeof sourceInfo !== "object") {
    throw new Error(`AgentResource.${resourceName}.sourceInfo must be a source info object.`);
  }
  return {
    source: sourceInfo.source,
    label: normalizeResourceText(`AgentResource.${resourceName}.sourceInfo.label`, sourceInfo.label),
    ...(sourceInfo.path ? { path: sourceInfo.path } : {}),
    ...(sourceInfo.scope ? { scope: sourceInfo.scope } : {})
  };
}

function assertNonBlank(field: string, value: string) {
  if (value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
}
