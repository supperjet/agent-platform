import type { AgentResourceName } from "../definition/agent-definition.js";
import type { ResolvedAgentDefinition } from "../definition/definition-resolver.js";
import type {
  LoadedResourceKind,
  LoadedResourceSnapshot,
  LoadedTextResource,
  ResourceDiagnostic,
  ResourceLoader
} from "./resource-loader.js";

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
  promptFragment: string; // Static prompt text injected into the assembled system prompt when this resource is active.
  sourceInfo: AgentResourceSourceInfo; // Catalog/debug metadata describing where the resource came from; not rendered as prompt text.
};

export type ResourceCatalogEntry = {
  name: AgentResourceName;
  label: string;
  kind?: LoadedResourceKind;
  promptFragment: string;
  sourceInfo: AgentResourceSourceInfo;
};

export type ResourceCatalogResourceInfo = {
  name: AgentResourceName;
  label: string;
  kind?: LoadedResourceKind;
  sourceInfo: AgentResourceSourceInfo;
};

export type ResourceCatalogResolution = {
  resourceNames: readonly AgentResourceName[];
  entries: readonly ResourceCatalogEntry[];
  resourceInfos: readonly ResourceCatalogResourceInfo[];
  promptFragments: readonly string[];
};

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

export class ResourceCatalog {
  constructor(
    private readonly registry: AgentResourceRegistry = createDefaultAgentResourceRegistry(),
    private readonly loader?: ResourceLoader
  ) {}

  load(input: ResourceCatalogLoadInput): ResourceSnapshot {
    const loaded = this.loader?.load() ?? {
      resources: [],
      diagnostics: []
    };
    const resolution = mergeResourceResolutions(
      this.resolveForDefinition(input.definition),
      createLoadedResourceResolution(loaded)
    );
    return {
      ...resolution,
      contextFilePaths: loaded.resources.flatMap((resource) =>
        resource.sourceInfo.path ? [resource.sourceInfo.path] : []
      ),
      skillNames: loaded.resources.flatMap((resource) =>
        resource.kind === "skill" ? [resource.name] : []
      ),
      loadedResources: loaded.resources,
      diagnostics: loaded.diagnostics
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

function createLoadedResourceResolution(
  loaded: LoadedResourceSnapshot
): ResourceCatalogResolution {
  const entries = loaded.resources
    .filter(shouldInjectLoadedResource)
    .map(createLoadedResourceCatalogEntry);
  return {
    resourceNames: entries.map((entry) => entry.name),
    entries,
    resourceInfos: entries.map(toResourceInfo),
    promptFragments: entries.map((entry) => entry.promptFragment)
  };
}

function shouldInjectLoadedResource(resource: LoadedTextResource): boolean {
  return resource.kind !== "prompt-template" && resource.kind !== "skill";
}

function createLoadedResourceCatalogEntry(
  resource: LoadedTextResource
): ResourceCatalogEntry {
  return {
    name: normalizeSingleResourceName("LoadedTextResource.name", resource.name),
    label: normalizeResourceText(`LoadedTextResource.${resource.name}.label`, resource.label),
    kind: resource.kind,
    promptFragment: formatLoadedResourcePromptFragment(resource),
    sourceInfo: {
      source: resource.sourceInfo.source,
      label: normalizeResourceText(`LoadedTextResource.${resource.name}.sourceInfo.label`, resource.sourceInfo.label),
      ...(resource.sourceInfo.path ? { path: resource.sourceInfo.path } : {}),
      scope: resource.sourceInfo.scope
    }
  };
}

function mergeResourceResolutions(
  registryResolution: ResourceCatalogResolution,
  loadedResolution: ResourceCatalogResolution
): ResourceCatalogResolution {
  return {
    resourceNames: [
      ...registryResolution.resourceNames,
      ...loadedResolution.resourceNames
    ],
    entries: [
      ...registryResolution.entries,
      ...loadedResolution.entries
    ],
    resourceInfos: [
      ...registryResolution.resourceInfos,
      ...loadedResolution.resourceInfos
    ],
    promptFragments: [
      ...registryResolution.promptFragments,
      ...loadedResolution.promptFragments
    ]
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
    case "system-prompt":
      return resource.content;
    case "append-system-prompt":
      return resource.content;
    case "prompt-template":
    case "skill":
      throw new Error(`Loaded resource kind "${resource.kind}" is not directly injectable.`);
  }
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
