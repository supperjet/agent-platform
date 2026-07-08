import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "mysql2/promise";
import type { SessionRecord } from "../session/contracts.js";
import { MySqlSessionStore } from "../session/mysql/mysql-session-store.js";

const session: SessionRecord = {
  sessionId: "session-1",
  status: "running",
  modelId: "deepseek-chat",
  agentState: {
    schemaVersion: 1,
    modelId: "deepseek-chat",
    payload: { messages: [{ role: "user", content: "hello" }] }
  },
  messageCount: 1,
  version: 2,
  executingCommandId: "command-1",
  leaseOwner: "worker-1",
  leaseUntil: 2_000,
  createdAt: 1_000,
  lastActiveAt: 1_100,
  updatedAt: 1_200
};

test("creates a session with serialized Agent state and execution lease", async () => {
  const calls: QueryCall[] = [];
  const store = new MySqlSessionStore(fakePool(calls, [result(1)]));

  assert.deepEqual(await store.createIfAbsent(session), { created: true, session });
  assert.match(calls[0]?.sql ?? "", /INSERT INTO sessions/);
  assert.deepEqual(calls[0]?.values, [
    "session-1",
    "running",
    "deepseek-chat",
    JSON.stringify(session.agentState),
    1,
    1,
    2,
    "command-1",
    "worker-1",
    2_000,
    1_000,
    1_100,
    1_200,
    null
  ]);
});

test("reads a stored session and restores its opaque Agent state", async () => {
  const store = new MySqlSessionStore(fakePool([], [[[{ ...sessionRow() }], []]]));

  assert.deepEqual(await store.find("session-1"), session);
});

test("returns the stored session after a duplicate insert", async () => {
  const store = new MySqlSessionStore(fakePool([], [
    duplicateEntry(),
    [[{ ...sessionRow(), status: "idle", executing_command_id: null, lease_owner: null, lease_until_ms: null }], []]
  ]));

  const creation = await store.createIfAbsent(session);

  assert.equal(creation.created, false);
  assert.equal(creation.session.status, "idle");
  assert.equal(creation.session.executingCommandId, undefined);
});

test("saves only when the expected Session version matches", async () => {
  const calls: QueryCall[] = [];
  const store = new MySqlSessionStore(fakePool(calls, [result(1), result(0)]));

  assert.equal(await store.save({ ...session, version: 3 }, 2), true);
  assert.equal(await store.save({ ...session, version: 3 }, 1), false);
  assert.match(calls[0]?.sql ?? "", /WHERE session_id = \? AND version = \?/);
  assert.deepEqual(calls[0]?.values.slice(-2), ["session-1", 2]);
});

test("atomically acquires an expired or empty execution lease", async () => {
  const calls: QueryCall[] = [];
  const store = new MySqlSessionStore(fakePool(calls, [
    result(1),
    [[{ ...sessionRow(), version: 3, lease_until_ms: 2_500 }], []]
  ]));

  const leased = await store.acquireExecutionLease({
    sessionId: "session-1",
    commandId: "command-1",
    leaseOwner: "worker-1",
    now: 1_500,
    leaseUntil: 2_500
  });

  assert.equal(leased?.leaseOwner, "worker-1");
  assert.match(calls[0]?.sql ?? "", /lease_until_ms IS NULL OR lease_until_ms <= \?/);
  assert.deepEqual(calls[0]?.values, [
    "command-1", "worker-1", 2_500, 1_500, 1_500, "session-1", 1_500
  ]);
});

test("returns undefined when another Worker owns the execution lease", async () => {
  const store = new MySqlSessionStore(fakePool([], [result(0)]));

  assert.equal(await store.acquireExecutionLease({
    sessionId: "session-1",
    commandId: "command-2",
    leaseOwner: "worker-2",
    now: 1_500,
    leaseUntil: 2_500
  }), undefined);
});

test("renews only a live lease owned by the same Worker and Command", async () => {
  const calls: QueryCall[] = [];
  const store = new MySqlSessionStore(fakePool(calls, [result(1), result(0)]));
  const lease = {
    sessionId: "session-1",
    commandId: "command-1",
    leaseOwner: "worker-1",
    now: 1_500,
    leaseUntil: 2_500
  };

  assert.equal(await store.renewExecutionLease(lease), true);
  assert.equal(await store.renewExecutionLease(lease), false);
  assert.match(calls[0]?.sql ?? "", /executing_command_id = \?/);
  assert.match(calls[0]?.sql ?? "", /lease_until_ms > \?/);
  assert.deepEqual(calls[0]?.values, [
    2_500, 1_500, "session-1", "command-1", "worker-1", 1_500
  ]);
});

test("rejects an incomplete execution lease from storage", async () => {
  const store = new MySqlSessionStore(fakePool([], [[[{
    ...sessionRow(),
    lease_owner: null
  }], []]]));

  await assert.rejects(store.find("session-1"), /incomplete execution lease/);
});

type QueryCall = { sql: string; values: readonly unknown[] };

function result(affectedRows: number) {
  return [{ affectedRows }, []];
}

function duplicateEntry() {
  return Object.assign(new Error("Duplicate entry"), { code: "ER_DUP_ENTRY" });
}

function sessionRow() {
  return {
    session_id: "session-1",
    status: "running",
    model_id: "deepseek-chat",
    agent_state: JSON.stringify(session.agentState),
    agent_state_schema_version: 1,
    message_count: 1,
    version: 2,
    executing_command_id: "command-1",
    lease_owner: "worker-1",
    lease_until_ms: 2_000,
    created_at_ms: 1_000,
    last_active_at_ms: 1_100,
    updated_at_ms: 1_200,
    closed_at_ms: null
  };
}

function fakePool(calls: QueryCall[], responses: unknown[]): Pool {
  return {
    async execute(sql: string, values: readonly unknown[] = []) {
      calls.push({ sql, values });
      const response = responses.shift();
      if (!response) throw new Error("Unexpected query.");
      if (response instanceof Error) throw response;
      return response;
    }
  } as unknown as Pool;
}
