import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AgentToolName } from "../definition/agent-definition.js";
import type { ResolvedAgentDefinition } from "../definition/definition-resolver.js";
import {
  createDefaultAgentToolRegistry,
  type AgentToolRegistry,
  type AgentToolSourceInfo
} from "./tool-registry.js";

export type ToolCatalogEntry = {
  name: AgentToolName;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines: readonly string[];
  sourceInfo: AgentToolSourceInfo;
  tool: AgentTool;
};

export type ToolCatalogToolInfo = {
  name: AgentToolName;
  label: string;
  description: string;
  parameters: AgentTool["parameters"];
  promptSnippet?: string;
  promptGuidelines: readonly string[];
  sourceInfo: AgentToolSourceInfo;
};

export type ToolCatalogResolution = {
  toolNames: readonly AgentToolName[];
  entries: readonly ToolCatalogEntry[];
  toolInfos: readonly ToolCatalogToolInfo[];
  tools: readonly AgentTool[];
};

export type ToolEnablementInput = {
  definition?: ResolvedAgentDefinition;
  toolName: AgentToolName;
  tool: AgentTool;
};

export type ToolEnablementDecision =
  | boolean
  | {
      enabled: boolean;
      reason?: string;
    };

export type ToolEnablementRule = (input: ToolEnablementInput) => ToolEnablementDecision;

export class ToolCatalog {
  constructor(
    private readonly registry: AgentToolRegistry = createDefaultAgentToolRegistry(),
    private readonly enablementRules: readonly ToolEnablementRule[] = []
  ) {}

  resolve(names: readonly AgentToolName[]): readonly AgentTool[] {
    return this.resolvePlan({ toolNames: names }).tools;
  }

  resolveForDefinition(definition: ResolvedAgentDefinition): ToolCatalogResolution {
    return this.resolvePlan({
      definition,
      toolNames: definition.toolNames
    });
  }

  getAllTools(): readonly ToolCatalogEntry[] {
    return this.registry.getAllEntries().map((entry) => createCatalogEntry(entry.definition.name, entry));
  }

  getAllToolInfos(): readonly ToolCatalogToolInfo[] {
    return this.getAllTools().map(toToolInfo);
  }

  getToolDefinition(name: AgentToolName): ToolCatalogEntry | undefined {
    const normalizedName = normalizeSingleToolName("ToolCatalog.toolName", name);
    const entry = this.registry.getEntry(normalizedName);
    if (!entry) return undefined;
    return createCatalogEntry(normalizedName, entry);
  }

  getToolInfo(name: AgentToolName): ToolCatalogToolInfo | undefined {
    const entry = this.getToolDefinition(name);
    if (!entry) return undefined;
    return toToolInfo(entry);
  }

  resolvePlan(input: {
    definition?: ResolvedAgentDefinition;
    toolNames: readonly AgentToolName[];
  }): ToolCatalogResolution {
    const toolNames = normalizeToolNames(input.toolNames);
    const registryEntries = this.registry.resolveEntries(toolNames);
    const entries = registryEntries.map((entry, index) => {
      const toolName = toolNames[index];
      if (!toolName) {
        throw new Error(`ToolCatalog resolved unexpected tool at index: ${index}`);
      }
      const { definition, tool } = entry;
      assertToolNameMatchesRequest(toolName, tool);
      assertToolEnabled({
        ...(input.definition ? { definition: input.definition } : {}),
        toolName,
        tool
      }, this.enablementRules);
      return createCatalogEntry(toolName, entry);
    });

    return {
      toolNames,
      entries,
      toolInfos: entries.map(toToolInfo),
      tools: entries.map((entry) => entry.tool)
    };
  }
}

function createCatalogEntry(toolName: AgentToolName, entry: {
  definition: {
    name: AgentToolName;
    label: string;
    description: string;
    promptSnippet?: string;
    promptGuidelines?: readonly string[];
  };
  sourceInfo: AgentToolSourceInfo;
  tool: AgentTool;
}): ToolCatalogEntry {
  const { definition } = entry;
  const promptSnippet = normalizeOptionalToolText(
    `AgentTool.${toolName}.promptSnippet`,
    definition.promptSnippet
  );
  return {
    name: normalizeSingleToolName(`AgentTool.${toolName}.name`, definition.name),
    label: normalizeToolText(`AgentTool.${toolName}.label`, definition.label),
    description: normalizeToolText(`AgentTool.${toolName}.description`, definition.description),
    ...(promptSnippet ? { promptSnippet } : {}),
    promptGuidelines: normalizePromptGuidelines(toolName, definition.promptGuidelines),
    sourceInfo: entry.sourceInfo,
    tool: entry.tool
  };
}

function toToolInfo(entry: ToolCatalogEntry): ToolCatalogToolInfo {
  return {
    name: entry.name,
    label: entry.label,
    description: entry.description,
    parameters: entry.tool.parameters,
    ...(entry.promptSnippet ? { promptSnippet: entry.promptSnippet } : {}),
    promptGuidelines: entry.promptGuidelines,
    sourceInfo: entry.sourceInfo
  };
}

function normalizeToolNames(names: readonly AgentToolName[]): readonly AgentToolName[] {
  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const name of names) {
    const normalizedName = normalizeSingleToolName("ToolCatalog.toolNames[]", name);
    if (seen.has(normalizedName)) {
      throw new Error(`ToolCatalog.toolNames contains duplicate tool name: ${normalizedName}`);
    }
    seen.add(normalizedName);
    normalized.push(normalizedName);
  }

  return normalized;
}

function normalizeSingleToolName(field: string, name: AgentToolName): AgentToolName {
  assertNonBlank(field, name);
  return name.trim();
}

function assertToolNameMatchesRequest(requestedName: string, tool: AgentTool) {
  assertNonBlank(`AgentTool.${requestedName}.name`, tool.name);
  if (tool.name !== requestedName) {
    throw new Error(`ToolCatalog resolved ${requestedName} to mismatched tool: ${tool.name}`);
  }
}

function assertToolEnabled(input: ToolEnablementInput, rules: readonly ToolEnablementRule[]) {
  for (const rule of rules) {
    const decision = normalizeEnablementDecision(rule(input));
    if (!decision.enabled) {
      const reason = decision.reason ? `: ${decision.reason}` : "";
      throw new Error(`ToolCatalog tool is disabled: ${input.toolName}${reason}`);
    }
  }
}

function normalizeEnablementDecision(decision: ToolEnablementDecision): { enabled: boolean; reason?: string } {
  if (typeof decision === "boolean") return { enabled: decision };
  return decision;
}

function normalizeToolText(field: string, value: string) {
  assertNonBlank(field, value);
  return value.trim();
}

function normalizeOptionalToolText(field: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  assertNonBlank(field, value);
  return value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

function normalizePromptGuidelines(toolName: string, guidelines: readonly string[] | undefined): readonly string[] {
  if (!guidelines) return [];
  const normalized = new Set<string>();
  for (const guideline of guidelines) {
    const value = normalizeOptionalToolText(`AgentTool.${toolName}.promptGuidelines[]`, guideline);
    if (value) normalized.add(value);
  }
  return [...normalized];
}

function assertNonBlank(field: string, value: string) {
  if (value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
}
