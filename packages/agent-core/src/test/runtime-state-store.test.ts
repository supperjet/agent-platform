import assert from "node:assert/strict";
import test from "node:test";
import {
  assessRuntimeRecovery,
  InMemoryRuntimeLogStore,
  InMemoryRuntimeStateStore,
  type AgentRuntimeStateSnapshot,
} from "../runtime/runtime-state-store.js";

test("stores runtime snapshots without exposing mutable references", async () => {
  const store = new InMemoryRuntimeStateStore();
  const snapshot: AgentRuntimeStateSnapshot = {
    snapshotId: "snapshot-1",
    sessionId: "session-1",
    status: "idle",
    dirtyState: "clean",
    queuedCommands: [],
    lastCommittedStateVersion: 2,
    updatedAt: "2026-07-29T01:00:00.000Z",
  };

  const saved = await store.save(snapshot);
  (saved.queuedCommands as Array<unknown>).push({
    commandId: "queued-1",
    command: { type: "prompt", text: "mutated" },
    queuedAt: "2026-07-29T01:00:01.000Z",
  });

  assert.deepEqual(await store.get("session-1"), snapshot);
});

test("assesses clean, dirty, and commit_failed runtime recovery", () => {
  const base: AgentRuntimeStateSnapshot = {
    snapshotId: "snapshot-1",
    sessionId: "session-1",
    status: "idle",
    dirtyState: "clean",
    queuedCommands: [],
    updatedAt: "2026-07-29T01:00:00.000Z",
  };

  assert.deepEqual(assessRuntimeRecovery(base), {
    sessionId: "session-1",
    status: "clean",
    shouldResumeActiveCommand: false,
    queuedCommands: [],
    queuedPromptPolicy: "host_decides",
    reason: "Runtime state is clean and can be restored from canonical conversation state.",
  });

  assert.equal(assessRuntimeRecovery({
    ...base,
    dirtyState: "dirty",
  }).status, "dirty");

  assert.equal(assessRuntimeRecovery({
    ...base,
    status: "commit_failed",
    dirtyState: "commit_failed",
  }).status, "commit_failed");
});

test("marks active commands as interrupted and never resumable", () => {
  const snapshot: AgentRuntimeStateSnapshot = {
    snapshotId: "snapshot-1",
    sessionId: "session-1",
    status: "running",
    dirtyState: "dirty",
    activeCommand: {
      commandId: "command-1",
      runId: "run-1",
      command: { type: "prompt", text: "hello" },
      startedAt: "2026-07-29T01:00:00.000Z",
    },
    queuedCommands: [
      {
        commandId: "command-2",
        command: { type: "prompt", text: "next" },
        queuedAt: "2026-07-29T01:00:01.000Z",
      },
    ],
    updatedAt: "2026-07-29T01:00:02.000Z",
  };

  assert.deepEqual(assessRuntimeRecovery(snapshot, {
    queuedPromptPolicy: "discard",
  }), {
    sessionId: "session-1",
    status: "interrupted",
    shouldResumeActiveCommand: false,
    interruptedCommand: snapshot.activeCommand,
    queuedCommands: snapshot.queuedCommands,
    queuedPromptPolicy: "discard",
    reason: "Runtime had an active command; recovery marks it interrupted and does not replay it.",
  });
});

test("records append-only runtime log entries in sequence order", async () => {
  const store = new InMemoryRuntimeLogStore();

  await store.append({
    entryId: "entry-2",
    sessionId: "session-1",
    sequence: 2,
    type: "command_finished",
    payload: { commandId: "command-1" },
    createdAt: "2026-07-29T01:00:02.000Z",
  });
  await store.append({
    entryId: "entry-1",
    sessionId: "session-1",
    sequence: 1,
    type: "command_accepted",
    payload: { commandId: "command-1" },
    createdAt: "2026-07-29T01:00:01.000Z",
  });

  assert.deepEqual((await store.listBySession("session-1")).map((entry) => entry.entryId), [
    "entry-1",
    "entry-2",
  ]);

  await assert.rejects(store.append({
    entryId: "entry-3",
    sessionId: "session-1",
    sequence: 2,
    type: "runtime_snapshot_saved",
    payload: {},
    createdAt: "2026-07-29T01:00:03.000Z",
  }), /sequence/);
});
