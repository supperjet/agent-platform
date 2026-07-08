import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import {
  SessionStore,
  type SessionLeaseRequest,
  type CreateSessionResult,
  type SessionRecord,
  type SessionStatus
} from "../contracts.js";

type SessionRow = RowDataPacket & {
  session_id: string;
  status: SessionStatus;
  model_id: string;
  agent_state: string | null;
  agent_state_schema_version: number | null;
  message_count: number;
  version: number;
  executing_command_id: string | null;
  lease_owner: string | null;
  lease_until_ms: number | null;
  created_at_ms: number;
  last_active_at_ms: number;
  updated_at_ms: number;
  closed_at_ms: number | null;
};

export class MySqlSessionStore extends SessionStore {
  constructor(private readonly pool: Pool) {
    super();
  }

  async createIfAbsent(session: SessionRecord): Promise<CreateSessionResult> {
    try {
      await this.pool.execute<ResultSetHeader>(
        `INSERT INTO sessions (
          session_id, status, model_id, agent_state, agent_state_schema_version,
          message_count, version, executing_command_id, lease_owner, lease_until_ms,
          created_at_ms, last_active_at_ms, updated_at_ms, closed_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        toParameters(session)
      );
      return { created: true, session: { ...session } };
    } catch (error) {
      if (!isDuplicateEntry(error)) throw error;
    }

    const existing = await this.find(session.sessionId);
    if (!existing) {
      throw new Error(`Session "${session.sessionId}" was not found after a duplicate insert.`);
    }
    return { created: false, session: existing };
  }

  async find(sessionId: string): Promise<SessionRecord | undefined> {
    const [rows] = await this.pool.execute<SessionRow[]>(
      `SELECT session_id, status, model_id, agent_state, agent_state_schema_version,
        message_count, version, executing_command_id, lease_owner, lease_until_ms,
        created_at_ms, last_active_at_ms, updated_at_ms, closed_at_ms
      FROM sessions
      WHERE session_id = ?`,
      [sessionId]
    );
    const row = rows[0];
    return row ? fromRow(row) : undefined;
  }

  async acquireExecutionLease(lease: SessionLeaseRequest): Promise<SessionRecord | undefined> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE sessions SET
        status = 'running', executing_command_id = ?, lease_owner = ?, lease_until_ms = ?,
        version = version + 1, last_active_at_ms = ?, updated_at_ms = ?
      WHERE session_id = ?
        AND status <> 'closed'
        AND (lease_until_ms IS NULL OR lease_until_ms <= ?)`,
      [
        lease.commandId,
        lease.leaseOwner,
        lease.leaseUntil,
        lease.now,
        lease.now,
        lease.sessionId,
        lease.now
      ]
    );
    if (result.affectedRows !== 1) return undefined;

    const session = await this.find(lease.sessionId);
    if (
      !session
      || session.executingCommandId !== lease.commandId
      || session.leaseOwner !== lease.leaseOwner
      || session.leaseUntil !== lease.leaseUntil
    ) {
      throw new Error(`Session "${lease.sessionId}" lease changed immediately after acquisition.`);
    }
    return session;
  }

  async renewExecutionLease(lease: SessionLeaseRequest): Promise<boolean> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE sessions SET lease_until_ms = ?, updated_at_ms = ?
      WHERE session_id = ?
        AND executing_command_id = ?
        AND lease_owner = ?
        AND lease_until_ms > ?`,
      [
        lease.leaseUntil,
        lease.now,
        lease.sessionId,
        lease.commandId,
        lease.leaseOwner,
        lease.now
      ]
    );
    return result.affectedRows === 1;
  }

  async save(session: SessionRecord, expectedVersion: number): Promise<boolean> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE sessions SET
        status = ?, model_id = ?, agent_state = ?, agent_state_schema_version = ?,
        message_count = ?, version = ?, executing_command_id = ?, lease_owner = ?,
        lease_until_ms = ?, created_at_ms = ?, last_active_at_ms = ?,
        updated_at_ms = ?, closed_at_ms = ?
      WHERE session_id = ? AND version = ?`,
      toUpdateParameters(session, expectedVersion)
    );
    return result.affectedRows === 1;
  }
}

function toParameters(session: SessionRecord) {
  return [
    session.sessionId,
    session.status,
    session.modelId,
    session.agentState === undefined ? null : JSON.stringify(session.agentState),
    session.agentState?.schemaVersion ?? null,
    session.messageCount,
    session.version,
    session.executingCommandId ?? null,
    session.leaseOwner ?? null,
    session.leaseUntil ?? null,
    session.createdAt,
    session.lastActiveAt,
    session.updatedAt,
    session.closedAt ?? null
  ];
}

function toUpdateParameters(session: SessionRecord, expectedVersion: number) {
  return [
    session.status,
    session.modelId,
    session.agentState === undefined ? null : JSON.stringify(session.agentState),
    session.agentState?.schemaVersion ?? null,
    session.messageCount,
    session.version,
    session.executingCommandId ?? null,
    session.leaseOwner ?? null,
    session.leaseUntil ?? null,
    session.createdAt,
    session.lastActiveAt,
    session.updatedAt,
    session.closedAt ?? null,
    session.sessionId,
    expectedVersion
  ];
}

function fromRow(row: SessionRow): SessionRecord {
  const lease = readLease(row);
  return {
    sessionId: row.session_id,
    status: row.status,
    modelId: row.model_id,
    ...(row.agent_state === null ? {} : { agentState: JSON.parse(row.agent_state) }),
    messageCount: Number(row.message_count),
    version: Number(row.version),
    ...lease,
    createdAt: Number(row.created_at_ms),
    lastActiveAt: Number(row.last_active_at_ms),
    updatedAt: Number(row.updated_at_ms),
    ...(row.closed_at_ms === null ? {} : { closedAt: Number(row.closed_at_ms) })
  };
}

function readLease(row: SessionRow) {
  const values = [row.executing_command_id, row.lease_owner, row.lease_until_ms];
  if (values.every((value) => value === null)) return {};
  if (values.some((value) => value === null)) {
    throw new Error(`Session "${row.session_id}" has an incomplete execution lease.`);
  }
  return {
    executingCommandId: row.executing_command_id!,
    leaseOwner: row.lease_owner!,
    leaseUntil: Number(row.lease_until_ms)
  };
}

function isDuplicateEntry(error: unknown): error is { code: "ER_DUP_ENTRY" } {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "ER_DUP_ENTRY";
}
