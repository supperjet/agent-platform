export type AgentStoredEventRetention = "required" | "diagnostic";

/**
 * 可持久化事件记录。
 *
 * EventStore 允许保存公共 runtime event，也允许宿主写入少量内部诊断事件
 * （例如 state_commit_failed）。这些事件用于回放 UI 和定位问题，不作为
 * ConversationStore 恢复 LLM messages 的唯一来源。
 */
export type AgentStoredEvent = {
  eventId: string;
  runId: string;
  sessionId: string;
  sequence: number;
  type: string;
  payload: unknown;
  retention?: AgentStoredEventRetention;
  createdAt: string;
};

/** append-only event stream 的持久化接口；具体介质由宿主实现。 */
export abstract class EventStore {
  abstract append(event: AgentStoredEvent): Promise<AgentStoredEvent>;
  abstract listByRun(runId: string): Promise<AgentStoredEvent[]>;
  abstract listBySession(sessionId: string): Promise<AgentStoredEvent[]>;
}

/** 测试和本地组合层可复用的最小内存实现。 */
export class InMemoryEventStore extends EventStore {
  private readonly events = new Map<string, AgentStoredEvent>();

  async append(event: AgentStoredEvent): Promise<AgentStoredEvent> {
    if (this.events.has(event.eventId)) {
      throw new Error(`Event "${event.eventId}" already exists.`);
    }
    const sequenceConflict = [...this.events.values()].find(
      (existing) => existing.runId === event.runId && existing.sequence === event.sequence,
    );
    if (sequenceConflict) {
      throw new Error(`Event sequence ${event.sequence} already exists for Run "${event.runId}".`);
    }
    this.events.set(event.eventId, { ...event });
    return { ...event };
  }

  async listByRun(runId: string): Promise<AgentStoredEvent[]> {
    return this.eventsByRun((event) => event.runId === runId);
  }

  async listBySession(sessionId: string): Promise<AgentStoredEvent[]> {
    return this.eventsBySession((event) => event.sessionId === sessionId);
  }

  private eventsByRun(predicate: (event: AgentStoredEvent) => boolean): AgentStoredEvent[] {
    return [...this.events.values()]
      .filter(predicate)
      .sort(compareRunEvents)
      .map((event) => ({ ...event }));
  }

  private eventsBySession(predicate: (event: AgentStoredEvent) => boolean): AgentStoredEvent[] {
    return [...this.events.values()]
      .filter(predicate)
      .sort(compareSessionEvents)
      .map((event) => ({ ...event }));
  }
}

function compareRunEvents(left: AgentStoredEvent, right: AgentStoredEvent): number {
  if (left.sequence !== right.sequence) return left.sequence - right.sequence;
  return left.eventId.localeCompare(right.eventId);
}

function compareSessionEvents(left: AgentStoredEvent, right: AgentStoredEvent): number {
  if (left.createdAt !== right.createdAt) return left.createdAt.localeCompare(right.createdAt);
  if (left.runId !== right.runId) return left.runId.localeCompare(right.runId);
  return compareRunEvents(left, right);
}
