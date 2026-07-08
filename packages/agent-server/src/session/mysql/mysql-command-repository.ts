import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import {
  CommandRepository,
  type CommandRecord,
  type CommandStatus,
  type CommandType,
  type CreateCommandResult
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

export class MySqlCommandRepository extends CommandRepository {
  constructor(private readonly pool: Pool) {
    super();
  }

  async createIfAbsent(command: CommandRecord): Promise<CreateCommandResult> {
    try {
      await this.pool.execute<ResultSetHeader>(
        `INSERT INTO commands (
          command_id, session_id, command_type, command_text, accepted,
          status, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        toParameters(command)
      );
      return { created: true, command: { ...command } };
    } catch (error) {
      if (!isDuplicateEntry(error)) throw error;
    }

    const existing = await this.find(command.commandId);
    if (!existing) {
      throw new Error(`Command "${command.commandId}" was not found after a duplicate insert.`);
    }
    return { created: false, command: existing };
  }

  async save(command: CommandRecord): Promise<void> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE commands SET
        session_id = ?, command_type = ?, command_text = ?, accepted = ?,
        status = ?, created_at_ms = ?, updated_at_ms = ?
      WHERE command_id = ?`,
      [
        command.sessionId,
        command.type,
        command.text ?? null,
        command.accepted === undefined ? null : Number(command.accepted),
        command.status,
        command.createdAt,
        command.updatedAt,
        command.commandId
      ]
    );
    if (result.affectedRows === 0) {
      throw new Error(`Cannot save missing command "${command.commandId}".`);
    }
  }

  async find(commandId: string): Promise<CommandRecord | undefined> {
    const [rows] = await this.pool.execute<CommandRow[]>(
      `SELECT command_id, session_id, command_type, command_text, accepted,
        status, created_at_ms, updated_at_ms
      FROM commands
      WHERE command_id = ?`,
      [commandId]
    );
    const row = rows[0];
    return row ? fromRow(row) : undefined;
  }
}

function isDuplicateEntry(error: unknown): error is { code: "ER_DUP_ENTRY" } {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "ER_DUP_ENTRY";
}

function toParameters(command: CommandRecord) {
  return [
    command.commandId,
    command.sessionId,
    command.type,
    command.text ?? null,
    command.accepted === undefined ? null : Number(command.accepted),
    command.status,
    command.createdAt,
    command.updatedAt
  ];
}

function fromRow(row: CommandRow): CommandRecord {
  return {
    commandId: row.command_id,
    sessionId: row.session_id,
    type: row.command_type,
    ...(row.command_text === null ? {} : { text: row.command_text }),
    ...(row.accepted === null ? {} : { accepted: row.accepted === 1 }),
    status: row.status,
    createdAt: Number(row.created_at_ms),
    updatedAt: Number(row.updated_at_ms)
  };
}
