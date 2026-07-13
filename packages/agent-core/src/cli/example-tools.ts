import { Type } from "@earendil-works/pi-ai";
import { defineAgentTool } from "../tools/tool-registry.js";

const inspectRuntimeParameters = Type.Object({
  topic: Type.String({ description: "Runtime topic to inspect." })
});

const readNoteParameters = Type.Object({
  noteId: Type.String({ description: "Static note id to read." })
});

const listCapabilitiesParameters = Type.Object({});

export const exampleInspectRuntimeTool = defineAgentTool({
  name: "inspect_runtime",
  label: "Inspect Runtime",
  description: "Inspect a runtime topic and return a concise diagnostic note.",
  promptSnippet: "Inspect runtime topics and return diagnostic notes.",
  promptGuidelines: ["Use inspect_runtime before answering questions about runtime assembly."],
  sourceInfo: { source: "sdk", label: "CLI example" },
  parameters: inspectRuntimeParameters,
  async execute(_toolCallId, params) {
    return {
      content: [{ type: "text", text: `Runtime topic inspected: ${params.topic}.` }],
      details: {}
    };
  }
});

export const exampleReadNoteTool = defineAgentTool({
  name: "read_note",
  label: "Read Note",
  description: "Read a static note from the CLI example note set.",
  promptSnippet: "Read static CLI example notes by id.",
  promptGuidelines: ["Use read_note when the answer should cite a local example note."],
  sourceInfo: { source: "sdk", label: "CLI example" },
  parameters: readNoteParameters,
  async execute(_toolCallId, params) {
    return {
      content: [{ type: "text", text: `Example note ${params.noteId}: prompt metadata is assembled before runtime execution.` }],
      details: { noteId: params.noteId }
    };
  }
});

export const exampleListCapabilitiesTool = defineAgentTool({
  name: "list_capabilities",
  label: "List Capabilities",
  description: "List the capabilities registered by the CLI example tool catalog.",
  promptSnippet: "List CLI example capabilities.",
  promptGuidelines: ["Use list_capabilities when the user asks what this CLI harness can do."],
  sourceInfo: { source: "sdk", label: "CLI example" },
  parameters: listCapabilitiesParameters,
  async execute() {
    return {
      content: [{ type: "text", text: "Available example capabilities: inspect_runtime, read_note, list_capabilities." }],
      details: {}
    };
  }
});

export const exampleCliTools = [
  exampleInspectRuntimeTool,
  exampleReadNoteTool,
  exampleListCapabilitiesTool
] as const;
