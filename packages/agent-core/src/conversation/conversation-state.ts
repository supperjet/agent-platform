import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentConversationState } from "../contracts.js";
import {
  type ConversationEntriesPayload,
  type ConversationEntry,
  type ConversationSnapshot,
  type LegacyConversationMessagesPayload
} from "./conversation-entry.js";
import { ConversationProjector } from "./conversation-projector.js";

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

export function exportConversationEntriesState(
  modelId: string,
  entries: readonly ConversationEntry[],
  leafId: string | null
): AgentConversationState {
  return {
    schemaVersion: 1,
    modelId,
    payload: {
      entries: structuredClone(entries),
      leafId
    }
  };
}

export function restoreConversationSnapshot(
  state: AgentConversationState | undefined,
  modelId: string,
  definitionId?: string
): ConversationSnapshot {
  if (!state) {
    return {
      entries: [],
      leafId: null,
      messages: [],
      compatibility: createCompatibility(modelId, definitionId)
    };
  }
  assertSupportedState(state, modelId);

  if (isLegacyMessagesPayload(state.payload)) {
    const entries = entriesFromMessages(state.payload.messages);
    const leafId = entries.at(-1)?.id ?? null;
    return createSnapshot(entries, leafId, modelId, definitionId);
  }

  if (isEntriesPayload(state.payload)) {
    const entries = structuredClone(state.payload.entries) as ConversationEntry[];
    return createSnapshot(entries, state.payload.leafId, modelId, definitionId);
  }

  throw new Error("Agent conversation state payload is invalid.");
}

export function restoreConversationMessages(
  state: AgentConversationState | undefined,
  modelId: string
): AgentMessage[] {
  return [...restoreConversationSnapshot(state, modelId).messages];
}

function assertSupportedState(state: AgentConversationState, modelId: string) {
  if (state.schemaVersion !== 1) {
    throw new Error(`Unsupported Agent conversation state version "${state.schemaVersion}".`);
  }
  if (state.modelId !== modelId) {
    throw new Error(`Agent conversation model "${state.modelId}" does not match runtime model "${modelId}".`);
  }
}

function createSnapshot(
  entries: readonly ConversationEntry[],
  leafId: string | null,
  modelId: string,
  definitionId?: string
): ConversationSnapshot {
  const projector = new ConversationProjector();
  return {
    entries: structuredClone(entries),
    leafId,
    messages: projector.projectMessages({ entries, leafId }),
    compatibility: createCompatibility(modelId, definitionId)
  };
}

function createCompatibility(modelId: string, definitionId?: string): ConversationSnapshot["compatibility"] {
  return {
    modelId,
    ...(definitionId ? { definitionId } : {})
  };
}

function entriesFromMessages(messages: readonly AgentMessage[]): ConversationEntry[] {
  return structuredClone(messages).map((message, index) => ({
    type: "message",
    id: `message:${index + 1}`,
    parentId: index === 0 ? null : `message:${index}`,
    timestamp: readMessageTimestamp(message),
    message
  }));
}

function readMessageTimestamp(message: AgentMessage): string {
  if ("timestamp" in message && typeof message.timestamp === "number") {
    return new Date(message.timestamp).toISOString();
  }
  return "1970-01-01T00:00:00.000Z";
}

function isLegacyMessagesPayload(payload: unknown): payload is LegacyConversationMessagesPayload {
  if (!payload || typeof payload !== "object" || !("messages" in payload)) return false;
  const messages = payload.messages;
  if (!Array.isArray(messages)) {
    throw new Error("Agent conversation state messages are invalid.");
  }
  return true;
}

function isEntriesPayload(payload: unknown): payload is ConversationEntriesPayload {
  if (!payload || typeof payload !== "object" || !("entries" in payload)) return false;
  const entries = payload.entries;
  if (!Array.isArray(entries)) {
    throw new Error("Agent conversation state entries are invalid.");
  }
  if (!("leafId" in payload) || (payload.leafId !== null && typeof payload.leafId !== "string")) {
    throw new Error("Agent conversation state leafId is invalid.");
  }
  for (const entry of entries) assertConversationEntry(entry);
  assertEntryGraph(entries, payload.leafId);
  return true;
}

function assertConversationEntry(entry: unknown): asserts entry is ConversationEntry {
  if (!entry || typeof entry !== "object") {
    throw new Error("Agent conversation state entries are invalid.");
  }
  if (!("type" in entry) || entry.type !== "message") {
    throw new Error("Agent conversation state contains unsupported entry.");
  }
  if (!("id" in entry) || typeof entry.id !== "string" || entry.id.trim().length === 0) {
    throw new Error("Agent conversation state entry id is invalid.");
  }
  if (!("parentId" in entry) || (entry.parentId !== null && typeof entry.parentId !== "string")) {
    throw new Error("Agent conversation state entry parentId is invalid.");
  }
  if (!("timestamp" in entry) || typeof entry.timestamp !== "string" || entry.timestamp.trim().length === 0) {
    throw new Error("Agent conversation state entry timestamp is invalid.");
  }
  if (!("message" in entry) || !entry.message || typeof entry.message !== "object") {
    throw new Error("Agent conversation state entry message is invalid.");
  }
}

function assertEntryGraph(entries: readonly ConversationEntry[], leafId: string | null) {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id)) {
      throw new Error(`Agent conversation state contains duplicate entry id: ${entry.id}`);
    }
    ids.add(entry.id);
  }
  if (leafId !== null && !ids.has(leafId)) {
    throw new Error(`Agent conversation state leafId does not reference an entry: ${leafId}`);
  }
  for (const entry of entries) {
    if (entry.parentId !== null && !ids.has(entry.parentId)) {
      throw new Error(`Agent conversation state entry parentId does not reference an entry: ${entry.parentId}`);
    }
  }
}
