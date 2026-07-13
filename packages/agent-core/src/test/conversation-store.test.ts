import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentConversationState } from "../contracts.js";
import type { ConversationEntry } from "../conversation/conversation-entry.js";
import { ConversationStore } from "../conversation/conversation-store.js";
import {
  exportConversationEntriesState,
  exportConversationState,
  restoreConversationMessages
} from "../conversation/conversation-state.js";

test("restores legacy message payloads as conversation entries", () => {
  const messages: AgentMessage[] = [
    { role: "user", content: "first" } as unknown as AgentMessage,
    { role: "assistant", content: "second" } as unknown as AgentMessage
  ];
  const state = exportConversationState("model-a", messages);
  const store = new ConversationStore();

  const snapshot = store.restore({
    state,
    modelId: "model-a",
    definitionId: "definition-a"
  });

  assert.deepEqual(snapshot.messages.map((message) => message.role), ["user", "assistant"]);
  assert.deepEqual(snapshot.entries.map((entry) => entry.id), ["message:1", "message:2"]);
  assert.equal(snapshot.entries[1]?.parentId, "message:1");
  assert.equal(snapshot.leafId, "message:2");
  assert.deepEqual(snapshot.compatibility, {
    modelId: "model-a",
    definitionId: "definition-a"
  });
  assert.notEqual(snapshot.messages, messages);
});

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
  const state = exportConversationState("model-a", []);

  assert.throws(
    () => store.restore({ state, modelId: "model-b" }),
    /does not match runtime model "model-b"/
  );
});

test("rejects malformed entry payloads", () => {
  const store = new ConversationStore();
  const state: AgentConversationState = {
    schemaVersion: 1,
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
    type: "message",
    id,
    parentId,
    timestamp: "1970-01-01T00:00:00.000Z",
    message: { role, content } as unknown as AgentMessage
  };
}

function readTestContent(message: AgentMessage): string {
  return String((message as { content?: unknown }).content ?? "");
}
