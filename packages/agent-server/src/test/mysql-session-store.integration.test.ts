import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createPool } from "mysql2/promise";
import type { SessionRecord } from "../session/contracts.js";
import { MySqlSessionStore } from "../session/mysql/mysql-session-store.js";

const mysqlUrl = process.env.MYSQL_INTEGRATION_URL;

test("persists Agent state and rejects a stale Session version", {
  skip: mysqlUrl ? false : "MYSQL_INTEGRATION_URL is not configured."
}, async () => {
  const sessionId = `integration-${randomUUID()}`;
  const session: SessionRecord = {
    sessionId,
    status: "idle",
    modelId: "deepseek-chat",
    agentState: {
      schemaVersion: 1,
      modelId: "deepseek-chat",
      payload: { messages: [{ role: "user", content: "你好，MySQL" }] }
    },
    messageCount: 1,
    version: 0,
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    updatedAt: Date.now()
  };

  const firstPool = createPool({ uri: mysqlUrl!, connectionLimit: 2 });
  try {
    const store = new MySqlSessionStore(firstPool);
    assert.equal((await store.createIfAbsent(session)).created, true);
  } finally {
    await firstPool.end();
  }

  const secondPool = createPool({ uri: mysqlUrl!, connectionLimit: 2 });
  try {
    const store = new MySqlSessionStore(secondPool);
    assert.deepEqual(await store.find(sessionId), session);

    const next = { ...session, status: "failed" as const, version: 1, updatedAt: session.updatedAt + 1 };
    assert.equal(await store.save(next, 0), true);
    assert.equal(await store.save({ ...next, version: 2 }, 0), false);
    assert.deepEqual(await store.find(sessionId), next);

    const now = Date.now();
    const [firstLease, secondLease] = await Promise.all([
      new MySqlSessionStore(secondPool).acquireExecutionLease({
        sessionId,
        commandId: "command-a",
        leaseOwner: "worker-a",
        now,
        leaseUntil: now + 60_000
      }),
      new MySqlSessionStore(secondPool).acquireExecutionLease({
        sessionId,
        commandId: "command-b",
        leaseOwner: "worker-b",
        now,
        leaseUntil: now + 60_000
      })
    ]);
    assert.equal([firstLease, secondLease].filter(Boolean).length, 1);
    const winner = firstLease ?? secondLease!;
    const renewedAt = now + 30_000;
    assert.equal(await store.renewExecutionLease({
      sessionId,
      commandId: winner.executingCommandId!,
      leaseOwner: winner.leaseOwner!,
      now: renewedAt,
      leaseUntil: now + 120_000
    }), true);
    assert.equal(await store.acquireExecutionLease({
      sessionId,
      commandId: "command-after-original-expiry",
      leaseOwner: "worker-late",
      now: now + 70_000,
      leaseUntil: now + 130_000
    }), undefined);
  } finally {
    await secondPool.execute("DELETE FROM sessions WHERE session_id = ?", [sessionId]);
    await secondPool.end();
  }
});
