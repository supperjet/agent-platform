import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentConversationState } from "../contracts.js";

export function exportConversationState(
  modelId: string,
  messages: AgentMessage[]
): AgentConversationState {
  return {
    schemaVersion: 1,
    modelId,
    payload: { messages: structuredClone(messages) }
  };
}

export function restoreConversationMessages(
  state: AgentConversationState | undefined,
  modelId: string
): AgentMessage[] {
  if (!state) return [];
  if (state.schemaVersion !== 1) {
    throw new Error(`Unsupported Agent conversation state version "${state.schemaVersion}".`);
  }
  if (state.modelId !== modelId) {
    throw new Error(`Agent conversation model "${state.modelId}" does not match runtime model "${modelId}".`);
  }
  if (!state.payload || typeof state.payload !== "object" || !("messages" in state.payload)) {
    throw new Error("Agent conversation state payload is invalid.");
  }
  const messages = state.payload.messages;
  if (!Array.isArray(messages)) {
    throw new Error("Agent conversation state messages are invalid.");
  }
  return structuredClone(messages) as AgentMessage[];
}
