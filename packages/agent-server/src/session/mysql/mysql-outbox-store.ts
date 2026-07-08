import { randomUUID } from "node:crypto";
import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { OutboxStore, type OutboxClaim } from "../contracts.js";

type OutboxRow = RowDataPacket & {
  event_id: string;
  aggregate_id: string;
  attempts: number;
};

export class MySqlOutboxStore extends OutboxStore {
  constructor(private readonly pool: Pool) {
    super();
  }

  // 声明下一个事件
  async claimNext(now: number, leaseDurationMs: number): Promise<OutboxClaim | undefined> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute<OutboxRow[]>(
        `SELECT event_id, aggregate_id, attempts
        FROM outbox_events
        WHERE event_type = 'command.queued'
          AND (
            (status = 'pending' AND available_at_ms <= ?)
            OR (status = 'processing' AND locked_until_ms <= ?)
          )
        ORDER BY available_at_ms, created_at_ms
        LIMIT 1
        FOR UPDATE`,
        [now, now]
      );
      const row = rows[0];
      if (!row) {
        await connection.commit();
        return undefined;
      }

      const leaseId = randomUUID();
      await connection.execute(
        `UPDATE outbox_events
        SET status = 'processing', locked_by = ?, locked_until_ms = ?, attempts = attempts + 1
        WHERE event_id = ?`,
        [leaseId, now + leaseDurationMs, row.event_id]
      );
      await connection.commit();
      return {
        eventId: row.event_id,
        commandId: row.aggregate_id,
        leaseId,
        attempts: Number(row.attempts) + 1
      };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  // 标记事件已发布
  async markPublished(claim: OutboxClaim, publishedAt: number) {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE outbox_events
      SET status = 'published', published_at_ms = ?, locked_by = NULL,
        locked_until_ms = NULL, last_error = NULL
      WHERE event_id = ? AND status = 'processing' AND locked_by = ?`,
      [publishedAt, claim.eventId, claim.leaseId]
    );
    assertLeaseOwned(result, claim);
  }

  // 重新调度事件
  async reschedule(claim: OutboxClaim, error: string, availableAt: number) {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE outbox_events
      SET status = 'pending', available_at_ms = ?, locked_by = NULL,
        locked_until_ms = NULL, last_error = ?
      WHERE event_id = ? AND status = 'processing' AND locked_by = ?`,
      [availableAt, error.slice(0, 2_000), claim.eventId, claim.leaseId]
    );
    assertLeaseOwned(result, claim);
  }
}

function assertLeaseOwned(result: ResultSetHeader, claim: OutboxClaim) {
  if (result.affectedRows !== 1) {
    throw new Error(`Outbox lease "${claim.leaseId}" no longer owns event "${claim.eventId}".`);
  }
}
