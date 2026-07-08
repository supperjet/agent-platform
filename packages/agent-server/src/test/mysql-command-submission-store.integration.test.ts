import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createPool, type RowDataPacket } from "mysql2/promise";
import { MySqlCommandSubmissionStore } from "../session/mysql/mysql-command-submission-store.js";

const mysqlUrl = process.env.MYSQL_INTEGRATION_URL;

test("commits one queued command and one outbox event for duplicate submissions", {
  skip: mysqlUrl ? false : "MYSQL_INTEGRATION_URL is not configured."
}, async () => {
  const pool = createPool({ uri: mysqlUrl!, connectionLimit: 2 });
  const commandId = `submission-${randomUUID()}`;
  const store = new MySqlCommandSubmissionStore(pool, () => 10_000);
  const command = {
    commandId,
    sessionId: "integration-session",
    type: "prompt" as const,
    text: "事务提交"
  };

  try {
    const created = await store.createQueuedIfAbsent(command);
    const duplicate = await store.createQueuedIfAbsent(command);

    assert.equal(created.created, true);
    assert.equal(created.command.status, "queued");
    assert.equal(duplicate.created, false);
    assert.deepEqual(duplicate.command, created.command);
    assert.equal(await count(pool, "commands", "command_id", commandId), 1);
    assert.equal(await count(pool, "outbox_events", "aggregate_id", commandId), 1);

    const [rows] = await pool.execute<Array<RowDataPacket & {
      event_type: string;
      payload: string;
      status: string;
    }>>(
      "SELECT event_type, payload, status FROM outbox_events WHERE aggregate_id = ?",
      [commandId]
    );
    assert.deepEqual(rows[0], {
      event_type: "command.queued",
      payload: JSON.stringify({ commandId }),
      status: "pending"
    });
  } finally {
    await pool.execute("DELETE FROM outbox_events WHERE aggregate_id = ?", [commandId]);
    await pool.execute("DELETE FROM commands WHERE command_id = ?", [commandId]);
    await pool.end();
  }
});

test("rolls back the command when the outbox insert fails", {
  skip: mysqlUrl ? false : "MYSQL_INTEGRATION_URL is not configured."
}, async () => {
  const pool = createPool({ uri: mysqlUrl!, connectionLimit: 2 });
  const commandId = `rollback-${randomUUID()}`;
  const eventId = `blocker-${randomUUID()}`;
  const store = new MySqlCommandSubmissionStore(pool, () => 20_000);

  try {
    await pool.execute(
      `INSERT INTO outbox_events (
        event_id, event_type, aggregate_id, payload, status,
        attempts, available_at_ms, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [eventId, "command.queued", commandId, "{}", "pending", 0, 20_000, 20_000]
    );

    await assert.rejects(store.createQueuedIfAbsent({
      commandId,
      sessionId: "integration-session",
      type: "prompt",
      text: "must roll back"
    }), (error: unknown) => hasCode(error, "ER_DUP_ENTRY"));

    assert.equal(await count(pool, "commands", "command_id", commandId), 0);
  } finally {
    await pool.execute("DELETE FROM outbox_events WHERE event_id = ?", [eventId]);
    await pool.execute("DELETE FROM commands WHERE command_id = ?", [commandId]);
    await pool.end();
  }
});

async function count(
  pool: ReturnType<typeof createPool>,
  table: "commands" | "outbox_events",
  column: "command_id" | "aggregate_id",
  value: string
) {
  const [rows] = await pool.execute<Array<RowDataPacket & { total: number }>>(
    `SELECT COUNT(*) AS total FROM ${table} WHERE ${column} = ?`,
    [value]
  );
  return Number(rows[0]?.total ?? 0);
}

function hasCode(error: unknown, code: string) {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
