import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "@earendil-works/pi-ai";
import type { AgentToolName } from "../definition/agent-definition.js";

export type AgentToolSourceInfo = {
  source: "builtin" | "registry" | "sdk" | "extension";
  label: string;
};

export type AgentToolMetadata = {
  promptSnippet: string; // One-line capability summary used in system prompts; narrower and more prompt-facing than description.
  promptGuidelines: readonly string[]; // Extra system prompt guideline bullets that apply only when this tool is active.
  sourceInfo: AgentToolSourceInfo; // Catalog/debug metadata describing where the tool came from; not needed by runtime execution.
};

export type AgentToolDefinition<TParams extends TSchema = TSchema, TDetails = any> =
  AgentTool<TParams, TDetails> & AgentToolMetadata;

export type AnyAgentToolDefinition = Omit<AgentTool, "execute" | "prepareArguments"> & AgentToolMetadata & {
  prepareArguments?: (args: unknown) => unknown;
  execute: (...args: any[]) => any;
};

export type AgentToolRegistryEntry = {
  definition: AnyAgentToolDefinition;
  sourceInfo: AgentToolSourceInfo;
  tool: AgentTool;
};

export type AgentToolRegistry = {
  resolve(names: readonly AgentToolName[]): readonly AgentTool[];
  resolveEntries(names: readonly AgentToolName[]): readonly AgentToolRegistryEntry[];
  getAllEntries(): readonly AgentToolRegistryEntry[];
  getEntry(name: AgentToolName): AgentToolRegistryEntry | undefined;
  getDefinition(name: AgentToolName): AnyAgentToolDefinition | undefined;
};

export function defineAgentTool<TParams extends TSchema, TDetails = any>(
  definition: AgentToolDefinition<TParams, TDetails>
): AgentToolDefinition<TParams, TDetails> {
  return definition;
}

export function createAgentToolRegistry(tools: readonly AnyAgentToolDefinition[]): AgentToolRegistry {
  const entriesByName = new Map<string, AgentToolRegistryEntry>();

  for (const tool of tools) {
    assertNonBlank("AgentToolRegistry.tools[].name", tool.name);
    if (entriesByName.has(tool.name)) {
      throw new Error(`AgentToolRegistry contains duplicate tool name: ${tool.name}`);
    }
    entriesByName.set(tool.name, createRegistryEntry(tool));
  }

  return {
    resolve(names) {
      return resolveEntries(entriesByName, names).map((entry) => entry.tool);
    },
    resolveEntries(names) {
      return resolveEntries(entriesByName, names);
    },
    getAllEntries() {
      return [...entriesByName.values()];
    },
    getEntry(name) {
      return entriesByName.get(name);
    },
    getDefinition(name) {
      return entriesByName.get(name)?.definition;
    }
  };
}

export function createDefaultAgentToolRegistry(): AgentToolRegistry {
  return createAgentToolRegistry([]);
}

export function wrapAgentToolDefinition(definition: AnyAgentToolDefinition): AgentTool {
  return {
    name: definition.name,
    label: definition.label,
    description: definition.description,
    parameters: definition.parameters,
    ...(definition.prepareArguments ? { prepareArguments: definition.prepareArguments } : {}),
    ...(definition.executionMode ? { executionMode: definition.executionMode } : {}),
    execute: definition.execute as AgentTool["execute"]
  };
}

function assertNonBlank(field: string, value: string) {
  if (value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
}

function createRegistryEntry(definition: AnyAgentToolDefinition): AgentToolRegistryEntry {
  return {
    definition,
    sourceInfo: definition.sourceInfo,
    tool: wrapAgentToolDefinition(definition)
  };
}

function resolveEntries(
  entriesByName: ReadonlyMap<string, AgentToolRegistryEntry>,
  names: readonly AgentToolName[]
): readonly AgentToolRegistryEntry[] {
  return names.map((name) => {
    assertNonBlank("AgentDefinition.toolNames[]", name);
    const entry = entriesByName.get(name);
    if (!entry) {
      throw new Error(`AgentToolRegistry does not contain tool: ${name}`);
    }
    return entry;
  });
}
