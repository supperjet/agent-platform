import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createPool, type RowDataPacket } from "mysql2/promise";
import { MySqlOutboxStore } from "../session/mysql/mysql-outbox-store.js";

const mysqlUrl = process.env.MYSQL_INTEGRATION_URL;

test("claims and publishes a pending outbox event", {
  skip: mysqlUrl ? false : "MYSQL_INTEGRATION_URL is not configured."
}, async () => {
  const pool = createPool({ uri: mysqlUrl!, connectionLimit: 2 });
  const eventId = `relay-${randomUUID()}`;
  const commandId = `relay-command-${randomUUID()}`;
  const store = new MySqlOutboxStore(pool);

  try {
    await insertOutbox(pool, eventId, commandId, "pending", 100);
    const claimed = await store.claimNext(100, 1_000);

    assert.equal(claimed?.eventId, eventId);
    assert.equal(claimed?.commandId, commandId);
    assert.equal(claimed?.attempts, 1);
    await store.markPublished(claimed!, 200);

    const row = await readOutbox(pool, eventId);
    assert.equal(row.status, "published");
    assert.equal(Number(row.published_at_ms), 200);
    assert.equal(row.locked_by, null);
  } finally {
    await pool.execute("DELETE FROM outbox_events WHERE event_id = ?", [eventId]);
    await pool.end();
  }
});

test("reschedules a failed outbox event for a later attempt", {
  skip: mysqlUrl ? false : "MYSQL_INTEGRATION_URL is not configured."
}, async () => {
  const pool = createPool({ uri: mysqlUrl!, connectionLimit: 2 });
  const eventId = `relay-retry-${randomUUID()}`;
  const commandId = `relay-command-${randomUUID()}`;
  const store = new MySqlOutboxStore(pool);

  try {
    await insertOutbox(pool, eventId, commandId, "pending", 100);
    const claimed = await store.claimNext(100, 1_000);
    await store.reschedule(claimed!, "temporary failure", 500);

    assert.equal(await store.claimNext(499, 1_000), undefined);
    const retried = await store.claimNext(500, 1_000);
    assert.equal(retried?.eventId, eventId);
    assert.equal(retried?.attempts, 2);
  } finally {
    await pool.execute("DELETE FROM outbox_events WHERE event_id = ?", [eventId]);
    await pool.end();
  }
});

async function insertOutbox(
  pool: ReturnType<typeof createPool>,
  eventId: string,
  commandId: string,
  status: string,
  availableAt: number
) {
  await pool.execute(
    `INSERT INTO outbox_events (
      event_id, event_type, aggregate_id, payload, status,
      attempts, available_at_ms, created_at_ms
    ) VALUES (?, 'command.queued', ?, ?, ?, 0, ?, ?)`,
    [eventId, commandId, JSON.stringify({ commandId }), status, availableAt, availableAt]
  );
}

async function readOutbox(pool: ReturnType<typeof createPool>, eventId: string) {
  const [rows] = await pool.execute<Array<RowDataPacket & {
    status: string;
    published_at_ms: number | null;
    locked_by: string | null;
  }>>(
    "SELECT status, published_at_ms, locked_by FROM outbox_events WHERE event_id = ?",
    [eventId]
  );
  return rows[0]!;
}
