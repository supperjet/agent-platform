import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ConversationEntry, ConversationEntryId } from "./conversation-entry.js";

export type ConversationProjectionInput = {
  entries: readonly ConversationEntry[];
  leafId?: ConversationEntryId | null;
};

export class ConversationProjector {
  projectMessages(input: ConversationProjectionInput): AgentMessage[] {
    return buildActiveEntries(input.entries, input.leafId ?? null).flatMap((entry) => {
      if (entry.type === "message") return [structuredClone(entry.message)];
      return [];
    });
  }
}

export function buildActiveEntries(
  entries: readonly ConversationEntry[],
  leafId: ConversationEntryId | null
): ConversationEntry[] {
  if (entries.length === 0) return [];
  if (!leafId) return [...entries];

  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const path: ConversationEntry[] = [];
  let current: ConversationEntry | undefined = byId.get(leafId);

  while (current) {
    path.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }

  if (path.length === 0) return [];
  return path.reverse();
}
