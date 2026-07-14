import { type AgentConversationState } from "../contracts.js";
import type {
  ConversationEntry,
  ConversationEntryId,
} from "../conversation/conversation-entry.js";
import { buildActiveEntries } from "../conversation/conversation-projector.js";
import { exportConversationEntriesState } from "../conversation/conversation-state.js";
import type { ConversationRuntimeState } from "../conversation/conversation-store.js";
import type { AgentLoopSnapshot } from "./agent-loop.js";

export type StateExporterOptions = {
  sessionId: string;
  conversation: ConversationRuntimeState;
};

/**
 * 状态导出器
 * 把 loop snapshot 同步成 conversation entry graph
 */

export class StateExporter {
  private readonly sessionId: string;
  private entries: ConversationEntry[];
  private leafId: ConversationEntryId | null;
  private entrySequence: number;

  constructor(options: StateExporterOptions) {
    this.sessionId = options.sessionId;
    this.entries = [...options.conversation.entries];
    this.leafId = options.conversation.leafId;
    this.entrySequence = readEntrySequence(this.entries);
  }

  syncFromSnapshot(snapshot: AgentLoopSnapshot) {
    const activeEntries = buildActiveEntries(this.entries, this.leafId);
    if (snapshot.messages.length < activeEntries.length) {
      throw new Error(
        "Agent conversation graph cannot sync after message history shrank.",
      );
    }

    const newMessages = snapshot.messages.slice(activeEntries.length);
    for (const message of newMessages) {
      const entry: ConversationEntry = {
        type: "message",
        id: this.nextEntryId(),
        parentId: this.leafId,
        timestamp: new Date().toISOString(),
        message: structuredClone(message),
      };
      this.entries.push(entry);
      this.leafId = entry.id;
    }
  }

  exportState(snapshot: AgentLoopSnapshot): AgentConversationState {
    this.syncFromSnapshot(snapshot);
    return exportConversationEntriesState(
      snapshot.modelId,
      this.entries,
      this.leafId,
    );
  }

  private nextEntryId() {
    this.entrySequence += 1;
    return `${this.sessionId}:entry:${this.entrySequence}`;
  }
}

function readEntrySequence(entries: readonly ConversationEntry[]) {
  return entries.reduce((max, entry) => {
    const prefix = `${entry.id.slice(0, entry.id.lastIndexOf(":") + 1)}`;
    if (!prefix.endsWith(":entry:")) return max;
    const value = Number(entry.id.slice(prefix.length));
    return Number.isInteger(value) && value > max ? value : max;
  }, 0);
}
