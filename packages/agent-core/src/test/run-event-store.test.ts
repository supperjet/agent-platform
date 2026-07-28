import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryEventStore } from "../runtime/event-store.js";
import { InMemoryRunStore } from "../runtime/run-store.js";
import {
  projectToolCallRecordsFromEvents,
  summarizeValue,
} from "../runtime/tool-call-record.js";

test("records run lifecycle outcomes by session", async () => {
  const store = new InMemoryRunStore();
  const startedAt = "2026-07-28T01:00:00.000Z";
  const endedAt = "2026-07-28T01:00:01.000Z";

  await store.start({
    runId: "run-1",
    sessionId: "session-1",
    commandId: "command-1",
    commandType: "prompt",
    startedAt
  });

  await store.finish("run-1", {
    status: "succeeded",
    outcome: { status: "succeeded" },
    endedAt
  });

  assert.deepEqual(await store.get("run-1"), {
    runId: "run-1",
    sessionId: "session-1",
    commandId: "command-1",
    commandType: "prompt",
    status: "succeeded",
    startedAt,
    endedAt,
    outcome: { status: "succeeded" }
  });
  assert.deepEqual((await store.listBySession("session-1")).map((run) => run.runId), ["run-1"]);
});

test("locates commit failure diagnostics through run and event records", async () => {
  const runs = new InMemoryRunStore();
  const events = new InMemoryEventStore();

  await runs.start({
    runId: "run-1",
    sessionId: "session-1",
    commandId: "command-1",
    commandType: "prompt",
    startedAt: "2026-07-28T01:00:00.000Z"
  });
  await events.append({
    eventId: "event-1",
    runId: "run-1",
    sessionId: "session-1",
    sequence: 1,
    type: "state_commit_failed",
    payload: {
      errorCode: "STATE_COMMIT_FAILED",
      message: "disk full"
    },
    createdAt: "2026-07-28T01:00:01.000Z"
  });
  await runs.finish("run-1", {
    status: "commit_failed",
    outcome: {
      status: "commit_failed",
      errorCode: "STATE_COMMIT_FAILED",
      message: "disk full"
    },
    endedAt: "2026-07-28T01:00:02.000Z"
  });

  assert.deepEqual(await runs.get("run-1"), {
    runId: "run-1",
    sessionId: "session-1",
    commandId: "command-1",
    commandType: "prompt",
    status: "commit_failed",
    startedAt: "2026-07-28T01:00:00.000Z",
    endedAt: "2026-07-28T01:00:02.000Z",
    outcome: {
      status: "commit_failed",
      errorCode: "STATE_COMMIT_FAILED",
      message: "disk full"
    }
  });
  assert.deepEqual((await events.listByRun("run-1")).map((event) => event.type), [
    "state_commit_failed"
  ]);
});

test("replays run events in sequence order", async () => {
  const store = new InMemoryEventStore();

  await store.append({
    eventId: "event-2",
    runId: "run-1",
    sessionId: "session-1",
    sequence: 2,
    type: "run_finished",
    payload: { status: "succeeded" },
    createdAt: "2026-07-28T01:00:02.000Z"
  });
  await store.append({
    eventId: "event-1",
    runId: "run-1",
    sessionId: "session-1",
    sequence: 1,
    type: "run_started",
    payload: { commandId: "command-1" },
    createdAt: "2026-07-28T01:00:01.000Z"
  });

  assert.deepEqual((await store.listByRun("run-1")).map((event) => event.eventId), [
    "event-1",
    "event-2"
  ]);
});

test("projects tool call recovery records from stored runtime events", async () => {
  const store = new InMemoryEventStore();

  await store.append({
    eventId: "event-3",
    runId: "run-1",
    sessionId: "session-1",
    sequence: 3,
    type: "tool_finished",
    payload: {
      type: "tool_finished",
      sessionId: "session-1",
      toolCallId: "call-1",
      isError: false,
      text: "file contents",
      sourceIds: []
    },
    createdAt: "2026-07-28T01:00:03.000Z"
  });
  await store.append({
    eventId: "event-1",
    runId: "run-1",
    sessionId: "session-1",
    sequence: 1,
    type: "tool_started",
    payload: {
      type: "tool_started",
      sessionId: "session-1",
      toolCallId: "call-1",
      toolName: "read",
      args: { path: "README.md" }
    },
    createdAt: "2026-07-28T01:00:01.000Z"
  });
  await store.append({
    eventId: "event-2",
    runId: "run-1",
    sessionId: "session-1",
    sequence: 2,
    type: "tool_progress",
    payload: {
      type: "tool_progress",
      sessionId: "session-1",
      toolCallId: "call-1",
      text: "reading"
    },
    createdAt: "2026-07-28T01:00:02.000Z"
  });

  assert.deepEqual(projectToolCallRecordsFromEvents(await store.listByRun("run-1")), [
    {
      runId: "run-1",
      sessionId: "session-1",
      toolCallId: "call-1",
      toolName: "read",
      argsSummary: {
        value: "{\"path\":\"README.md\"}",
        truncated: false
      },
      status: "succeeded",
      startedAt: "2026-07-28T01:00:01.000Z",
      endedAt: "2026-07-28T01:00:03.000Z",
      resultSummary: {
        value: "file contents",
        truncated: false
      },
      startedEventId: "event-1",
      finishedEventId: "event-3",
      interrupted: false
    }
  ]);
});

test("marks unfinished tool calls as aborted during recovery projection", async () => {
  const store = new InMemoryEventStore();

  await store.append({
    eventId: "event-1",
    runId: "run-1",
    sessionId: "session-1",
    sequence: 1,
    type: "tool_started",
    payload: {
      type: "tool_started",
      sessionId: "session-1",
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "sleep 30" }
    },
    createdAt: "2026-07-28T01:00:01.000Z"
  });

  const records = projectToolCallRecordsFromEvents(await store.listByRun("run-1"), {
    recoveryTimestamp: "2026-07-28T01:00:10.000Z"
  });

  assert.equal(records[0]?.status, "aborted");
  assert.equal(records[0]?.interrupted, true);
  assert.equal(records[0]?.endedAt, "2026-07-28T01:00:10.000Z");
  assert.equal(records[0]?.finishedEventId, undefined);
  assert.match(records[0]?.errorSummary?.value ?? "", /no terminal event/);
});

test("summarizes large tool call payloads without storing full artifacts", () => {
  assert.deepEqual(summarizeValue({ content: "abcdef" }, 10), {
    value: "{\"content\"",
    truncated: true
  });
});

test("rejects ambiguous run and event records", async () => {
  const runs = new InMemoryRunStore();
  const events = new InMemoryEventStore();

  await runs.start({
    runId: "run-1",
    sessionId: "session-1",
    commandId: "command-1",
    commandType: "prompt",
    startedAt: "2026-07-28T01:00:00.000Z"
  });
  await assert.rejects(runs.start({
    runId: "run-1",
    sessionId: "session-1",
    commandId: "command-2",
    commandType: "prompt",
    startedAt: "2026-07-28T01:00:01.000Z"
  }), /already exists/);

  await events.append({
    eventId: "event-1",
    runId: "run-1",
    sessionId: "session-1",
    sequence: 1,
    type: "run_started",
    payload: {},
    createdAt: "2026-07-28T01:00:00.000Z"
  });
  await assert.rejects(events.append({
    eventId: "event-2",
    runId: "run-1",
    sessionId: "session-1",
    sequence: 1,
    type: "message_finished",
    payload: {},
    createdAt: "2026-07-28T01:00:01.000Z"
  }), /sequence/);
});
