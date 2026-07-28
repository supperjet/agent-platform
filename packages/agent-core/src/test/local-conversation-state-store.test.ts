import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { AgentConversationState } from "../contracts.js";
import { LocalConversationStateStore } from "../conversation/local-conversation-state-store.js";

test("saves and loads a local conversation state snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-core-local-state-"));
  try {
    const stateFile = join(root, "sessions", "session-1", "state.json");
    const store = new LocalConversationStateStore({
      stateFile,
      now: () => new Date("2026-07-26T00:00:00.000Z")
    });

    const saved = await store.save({
      sessionId: "session-1",
      agentState: state("model-a"),
      sessionInfo: {
        cwd: "/workspace/project",
        modelId: "model-a"
      }
    });
    const loaded = await store.load();

    assert.deepEqual(saved, loaded);
    assert.equal(JSON.parse(await readFile(stateFile, "utf8")).formatVersion, 1);
    assert.equal(loaded?.agentState.schemaVersion, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("returns undefined when the local conversation state file does not exist", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-core-local-state-"));
  try {
    const store = new LocalConversationStateStore({
      stateFile: join(root, "missing", "state.json")
    });

    assert.equal(await store.load(), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deletes a local conversation state snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-core-local-state-"));
  try {
    const store = new LocalConversationStateStore({
      stateFile: join(root, "session.json")
    });
    await store.save({ sessionId: "session-1", agentState: state("model-a") });

    assert.equal(await store.delete(), true);
    assert.equal(await store.load(), undefined);
    assert.equal(await store.delete(), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects unsupported local conversation state files", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-core-local-state-"));
  try {
    const stateFile = join(root, "state.json");
    await writeFile(stateFile, JSON.stringify({
      formatVersion: 1,
      sessionId: "session-1",
      updatedAt: "2026-07-26T00:00:00.000Z",
      agentState: {
        schemaVersion: 1,
        modelId: "model-a",
        payload: { messages: [] }
      }
    }), "utf8");
    const store = new LocalConversationStateStore({ stateFile });

    await assert.rejects(store.load(), /schemaVersion 2/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function state(modelId: string): AgentConversationState {
  return {
    schemaVersion: 2,
    modelId,
    payload: {
      entries: [],
      leafId: null
    }
  };
}
