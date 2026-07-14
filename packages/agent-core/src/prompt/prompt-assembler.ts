/**
 * Builds the runtime system prompt from already-resolved assembly inputs.
 *
 * This module mirrors the prompt boundary in Pi coding-agent: upstream catalogs
 * resolve definitions, tools, and resources; the prompt assembler only decides
 * how those pieces are presented to the model. It consumes tool prompt metadata
 * such as snippets and guidelines, but it does not resolve tools or load
 * resources itself.
 */
import type { ResolvedAgentDefinition } from "../definition/definition-resolver.js";
import type { ResourceSnapshot } from "../resources/resource-catalog.js";
import type { ToolCatalogResolution } from "../tools/tool-catalog.js";

export type PromptAssemblerInput = {
  definition: ResolvedAgentDefinition;
  resources: ResourceSnapshot;
  toolPlan: ToolCatalogResolution;
};

export type PromptSection = {
  name: "instructions" | "availableTools" | "guidelines" | "resources";
  content: string;
};

export type PromptPlan = {
  sections: readonly PromptSection[];
  toolSnippets: Readonly<Record<string, string>>;
  toolGuidelines: readonly string[];
  systemPrompt: string;
};

export class PromptAssembler {
  assemble(input: PromptAssemblerInput): PromptPlan {
    const toolSnippets = collectToolSnippets(input.toolPlan);
    const toolGuidelines = collectToolGuidelines(input.toolPlan);
    const sections: PromptSection[] = [];

    addSection(sections, "instructions", input.definition.instructionText);
    addSection(sections, "availableTools", formatAvailableTools(toolSnippets));
    addSection(sections, "guidelines", formatGuidelines(toolGuidelines));
    addSection(
      sections,
      "resources",
      input.resources.promptFragments.join("\n\n"),
    );

    return {
      sections,
      toolSnippets,
      toolGuidelines,
      systemPrompt: sections.map((section) => section.content).join("\n\n"),
    };
  }
}

function collectToolSnippets(
  toolPlan: ToolCatalogResolution,
): Readonly<Record<string, string>> {
  const snippets: Record<string, string> = {};
  for (const entry of toolPlan.entries) {
    if (!entry.promptSnippet) continue;
    snippets[entry.name] = entry.promptSnippet;
  }
  return snippets;
}

function collectToolGuidelines(
  toolPlan: ToolCatalogResolution,
): readonly string[] {
  const guidelines = new Set<string>();
  for (const entry of toolPlan.entries) {
    for (const guideline of entry.promptGuidelines) {
      guidelines.add(guideline);
    }
  }
  return [...guidelines];
}

function formatAvailableTools(
  toolSnippets: Readonly<Record<string, string>>,
): string {
  const entries = Object.entries(toolSnippets);
  if (entries.length === 0) return "";
  return [
    "Available tools:",
    ...entries.map(([name, snippet]) => `- ${name}: ${snippet}`),
  ].join("\n");
}

function formatGuidelines(guidelines: readonly string[]): string {
  if (guidelines.length === 0) return "";
  return [
    "Guidelines:",
    ...guidelines.map((guideline) => `- ${guideline}`),
  ].join("\n");
}

function addSection(
  sections: PromptSection[],
  name: PromptSection["name"],
  content: string,
) {
  const normalized = content.trim();
  if (!normalized) return;
  sections.push({ name, content: normalized });
}
