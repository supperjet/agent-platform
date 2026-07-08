import type { Pool, RowDataPacket } from "mysql2/promise";
import {
  CommandSubmissionStore,
  type CommandRecord,
  type CommandStatus,
  type CommandType,
  type CreateCommandResult,
  type SubmitCommand
} from "../contracts.js";

type CommandRow = RowDataPacket & {
  command_id: string;
  session_id: string;
  command_type: CommandType;
  command_text: string | null;
  accepted: number | null;
  status: CommandStatus;
  created_at_ms: number;
  updated_at_ms: number;
};

export class MySqlCommandSubmissionStore extends CommandSubmissionStore {
  constructor(
    private readonly pool: Pool,
    private readonly now: () => number = Date.now
  ) {
    super();
  }

  async createQueuedIfAbsent(command: SubmitCommand): Promise<CreateCommandResult> {
    const now = this.now();
    const record: CommandRecord = {
      commandId: command.commandId,
      sessionId: command.sessionId,
      type: command.type,
      ...(command.text === undefined ? {} : { text: command.text }),
      accepted: true,
      status: "queued",
      createdAt: now,
      updatedAt: now
    };
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute(
        `INSERT INTO commands (
          command_id, session_id, command_type, command_text, accepted,
          status, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          record.commandId,
          record.sessionId,
          record.type,
          record.text ?? null,
          1,
          record.status,
          record.createdAt,
          record.updatedAt
        ]
      );
      await connection.execute(
        `INSERT INTO outbox_events (
          event_id, event_type, aggregate_id, payload, status,
          attempts, available_at_ms, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          outboxEventId(record.commandId),
          "command.queued",
          record.commandId,
          JSON.stringify({ commandId: record.commandId }),
          "pending",
          0,
          now,
          now
        ]
      );
      await connection.commit();
      return { created: true, command: record };
    } catch (error) {
      await connection.rollback();
      if (!isDuplicateEntry(error)) throw error;
      const existing = await findCommand(this.pool, command.commandId);
      if (!existing) throw error;
      return { created: false, command: existing };
    } finally {
      connection.release();
    }
  }
}

function outboxEventId(commandId: string) {
  return `command:${commandId}:queued`;
}

function isDuplicateEntry(error: unknown): error is { code: "ER_DUP_ENTRY" } {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "ER_DUP_ENTRY";
}

async function findCommand(pool: Pool, commandId: string): Promise<CommandRecord | undefined> {
  const [rows] = await pool.execute<CommandRow[]>(
    `SELECT command_id, session_id, command_type, command_text, accepted,
      status, created_at_ms, updated_at_ms
    FROM commands
    WHERE command_id = ?`,
    [commandId]
  );
  const row = rows[0];
  return row ? {
    commandId: row.command_id,
    sessionId: row.session_id,
    type: row.command_type,
    ...(row.command_text === null ? {} : { text: row.command_text }),
    ...(row.accepted === null ? {} : { accepted: row.accepted === 1 }),
    status: row.status,
    createdAt: Number(row.created_at_ms),
    updatedAt: Number(row.updated_at_ms)
  } : undefined;
}
