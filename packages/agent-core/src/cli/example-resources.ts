import { defineAgentResource } from "../resources/resource-catalog.js";

export const exampleRuntimeNotesResource = defineAgentResource({
  name: "runtime_notes",
  label: "Runtime Notes",
  promptFragment: [
    "Runtime notes:",
    "- Runtime assembly resolves definition, resources, tools, prompt, model, and conversation before execution.",
    "- Static resources are assembled before each runtime is created; they are not loaded dynamically in ResourceCatalog v1."
  ].join("\n"),
  sourceInfo: { source: "sdk", label: "CLI example" }
});

export const examplePromptRulesResource = defineAgentResource({
  name: "prompt_rules",
  label: "Prompt Rules",
  promptFragment: [
    "Prompt rules:",
    "- Treat resource prompt fragments as stable system prompt material.",
    "- Keep per-turn temporary context outside the static prompt plan."
  ].join("\n"),
  sourceInfo: { source: "sdk", label: "CLI example" }
});

export const exampleCliResources = [
  exampleRuntimeNotesResource,
  examplePromptRulesResource
] as const;
