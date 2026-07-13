import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentConversationState } from "../contracts.js";
import type { ConversationSnapshot } from "./conversation-entry.js";
import { restoreConversationSnapshot } from "./conversation-state.js";

export type ConversationRestoreInput = {
  state?: AgentConversationState;
  modelId: string;
  definitionId?: string;
};

export type ConversationRuntimeState = ConversationSnapshot & {
  messages: AgentMessage[];
};

export class ConversationStore {
  restore(input: ConversationRestoreInput): ConversationRuntimeState {
    const snapshot = restoreConversationSnapshot(input.state, input.modelId, input.definitionId);
    return {
      ...snapshot,
      messages: [...snapshot.messages]
    };
  }
}
