import type { AgentMessage } from "@earendil-works/pi-agent-core";

export type ConversationEntryId = string;

export type ConversationMessageEntry = {
  type: "message";
  id: ConversationEntryId;
  parentId: ConversationEntryId | null;
  timestamp: string;
  message: AgentMessage;
};

export type ConversationEntry = ConversationMessageEntry;

export type ConversationSnapshot = {
  entries: readonly ConversationEntry[];
  leafId: ConversationEntryId | null;
  messages: readonly AgentMessage[];
  compatibility: {
    modelId: string;
    definitionId?: string;
  };
};

export type ConversationEntriesPayload = {
  entries: readonly ConversationEntry[];
  leafId: ConversationEntryId | null;
};

export type LegacyConversationMessagesPayload = {
  messages: readonly AgentMessage[];
};
