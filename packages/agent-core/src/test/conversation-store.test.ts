import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentConversationState } from "../contracts.js";
import type { ConversationEntry } from "../conversation/conversation-entry.js";
import { ConversationStore } from "../conversation/conversation-store.js";
import {
  exportConversationEntriesState,
  restoreConversationMessages
} from "../conversation/conversation-state.js";

test("restores entry payloads through the current leaf path", () => {
  const entries: ConversationEntry[] = [
    createMessageEntry("root", null, "user", "root prompt"),
    createMessageEntry("main", "root", "assistant", "main answer"),
    createMessageEntry("branch", "root", "assistant", "branch answer")
  ];
  const state = exportConversationEntriesState("model-a", entries, "branch");
  const store = new ConversationStore();

  const snapshot = store.restore({ state, modelId: "model-a" });

  assert.deepEqual(snapshot.entries.map((entry) => entry.id), ["root", "main", "branch"]);
  assert.deepEqual(snapshot.messages.map(readTestContent), ["root prompt", "branch answer"]);
  assert.equal(snapshot.leafId, "branch");
});

test("restores v2 entries while projecting compaction summaries", () => {
  const entries: ConversationEntry[] = [
    createMessageEntry("root", null, "user", "root prompt"),
    {
      kind: "compaction",
      id: "summary",
      parentId: "root",
      createdAt: "2026-07-24T00:00:01.000Z",
      payload: {
        summary: "Earlier work was summarized.",
        sourceEntryIds: ["root"],
        reason: "manual",
        createdBy: "runtime"
      }
    },
    createMessageEntry("answer", "summary", "assistant", "answer after summary"),
    {
      kind: "custom_state",
      id: "planner-state",
      parentId: "answer",
      createdAt: "2026-07-24T00:00:03.000Z",
      payload: {
        namespace: "planner",
        state: { phase: "D.1" }
      }
    },
    {
      kind: "session_info",
      id: "session-info",
      parentId: "planner-state",
      createdAt: "2026-07-24T00:00:04.000Z",
      payload: {
        cwd: "/workspace/project",
        definitionId: "restore-agent"
      }
    },
    {
      kind: "future_entry",
      id: "future",
      parentId: "session-info",
      createdAt: "2026-07-24T00:00:05.000Z",
      payload: { value: true }
    }
  ];
  const state = exportConversationEntriesState("model-a", entries, "future");
  const store = new ConversationStore();

  const snapshot = store.restore({ state, modelId: "model-a" });

  assert.equal(state.schemaVersion, 2);
  assert.deepEqual(
    snapshot.entries.map((entry) => entry.id),
    ["root", "summary", "answer", "planner-state", "session-info", "future"]
  );
  assert.deepEqual(snapshot.messages.map(readTestContent), [
    "此前对话摘要：\nEarlier work was summarized.",
    "answer after summary"
  ]);
  assert.equal(snapshot.leafId, "future");
});

test("projects compaction summary in place of covered source messages without deleting entries", () => {
  const entries: ConversationEntry[] = [
    createMessageEntry("first", null, "user", "first prompt"),
    createMessageEntry("second", "first", "assistant", "second answer"),
    createMessageEntry("third", "second", "user", "recent prompt"),
    {
      kind: "compaction",
      id: "summary",
      parentId: "third",
      createdAt: "2026-07-24T00:00:03.000Z",
      payload: {
        summary: "The user asked first; the assistant answered second.",
        sourceEntryIds: ["first", "second"],
        reason: "manual",
        createdBy: "runtime",
        preservedEntryIds: ["third"],
        instructions: "Keep facts only."
      }
    }
  ];
  const state = exportConversationEntriesState("model-a", entries, "summary");
  const store = new ConversationStore();

  const snapshot = store.restore({ state, modelId: "model-a" });

  assert.deepEqual(snapshot.entries.map((entry) => entry.id), ["first", "second", "third", "summary"]);
  assert.deepEqual(snapshot.messages.map(readTestContent), [
    "此前对话摘要：\nThe user asked first; the assistant answered second.",
    "recent prompt"
  ]);
  assert.equal(state.payload.entries.length, 4);
});

test("restores empty state to an empty conversation snapshot", () => {
  const store = new ConversationStore();

  const snapshot = store.restore({ modelId: "model-a" });

  assert.deepEqual(snapshot.entries, []);
  assert.equal(snapshot.leafId, null);
  assert.deepEqual(snapshot.messages, []);
  assert.deepEqual(snapshot.compatibility, { modelId: "model-a" });
});

test("keeps restoreConversationMessages compatible with new entry payloads", () => {
  const entries: ConversationEntry[] = [
    createMessageEntry("first", null, "user", "first"),
    createMessageEntry("second", "first", "assistant", "second")
  ];
  const state = exportConversationEntriesState("model-a", entries, "second");

  const messages = restoreConversationMessages(state, "model-a");

  assert.deepEqual(messages.map(readTestContent), ["first", "second"]);
});

test("rejects conversation state restored with a different model", () => {
  const store = new ConversationStore();
  const state = exportConversationEntriesState("model-a", [], null);

  assert.throws(
    () => store.restore({ state, modelId: "model-b" }),
    /does not match runtime model "model-b"/
  );
});

test("rejects malformed entry payloads", () => {
  const store = new ConversationStore();
  const state: AgentConversationState = {
    schemaVersion: 2,
    modelId: "model-a",
    payload: {
      entries: [
        createMessageEntry("first", null, "user", "first"),
        createMessageEntry("second", "missing", "assistant", "second")
      ],
      leafId: "second"
    }
  };

  assert.throws(
    () => store.restore({ state, modelId: "model-a" }),
    /parentId does not reference an entry: missing/
  );
});

function createMessageEntry(
  id: string,
  parentId: string | null,
  role: "user" | "assistant",
  content: string
): ConversationEntry {
  return {
    kind: "message",
    id,
    parentId,
    createdAt: "2026-07-24T00:00:00.000Z",
    payload: {
      message: { role, content } as unknown as AgentMessage
    }
  };
}

function readTestContent(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.flatMap((part) => {
      if (part && typeof part === "object" && "text" in part) {
        return [String((part as { text: unknown }).text)];
      }
      return [];
    }).join("");
  }
  return String(content ?? "");
}
