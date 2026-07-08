import { SessionQuery, type SessionSnapshot, type SessionStore } from "../contracts.js";

/** Reads durable Session metadata without constructing an Agent runtime in the Server process. */
export class StoredSessionQuery extends SessionQuery {
  constructor(private readonly sessions: SessionStore) {
    super();
  }

  async snapshot(sessionId: string): Promise<SessionSnapshot | undefined> {
    const record = await this.sessions.find(sessionId);
    return record ? {
      sessionId: record.sessionId,
      status: record.status,
      createdAt: record.createdAt,
      lastActiveAt: record.lastActiveAt,
      messageCount: record.messageCount,
      modelId: record.modelId
    } : undefined;
  }
}
