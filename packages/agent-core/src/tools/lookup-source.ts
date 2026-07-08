import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

const sourceParameters = Type.Object({
  topic: Type.String({ description: "Topic to look up." })
});

/** Example source lookup capability used by the current Agent profile. */
export const lookupSourceTool: AgentTool<typeof sourceParameters, { sourceIds: string[] }> = {
  name: "lookup_source",
  label: "Lookup Source",
  description: "Return a stable source id for a source-card projection.",
  parameters: sourceParameters,
  async execute(toolCallId, params, signal, onUpdate) {
    signal?.throwIfAborted();
    onUpdate?.({
      content: [{ type: "text", text: `Looking up ${params.topic}...` }],
      details: { sourceIds: [] }
    });

    return {
      content: [{ type: "text", text: `Found architecture note for ${params.topic}.` }],
      details: { sourceIds: [`source:${toolCallId}`] }
    };
  }
};
