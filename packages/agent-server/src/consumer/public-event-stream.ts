import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentNotification } from "../messaging/events.js";
import type { BrowserEventProjector } from "./browser-events.js";
import type { PublicAgentEvent } from "./contracts.js";

export type PublicEventListener = (event: PublicAgentEvent) => void;

/** Consumer-facing seam used by HTTP history and SSE delivery. */
export abstract class PublicEventStream {
  abstract ready(): Promise<void>;
  abstract read(sessionId: string): PublicAgentEvent[];
  abstract subscribe(sessionId: string, listener: PublicEventListener): () => void;
  abstract close(): void | Promise<void>;
}

/** In-process adapter that correlates Runtime events and exposes the public event stream. */
export class InMemoryPublicEventStream extends PublicEventStream {
  private readonly commandContext = new AsyncLocalStorage<{ sessionId: string; commandId: string }>();
  private readonly eventsBySession = new Map<string, PublicAgentEvent[]>();
  private readonly listenersBySession = new Map<string, Set<PublicEventListener>>();

  constructor(private readonly projector: BrowserEventProjector) {
    super();
  }

  run<T>(sessionId: string, commandId: string, operation: () => Promise<T>) {
    return this.commandContext.run({ sessionId, commandId }, operation);
  }

  async ready() {}

  accept(
    notification: AgentNotification,
    commandId?: string,
    eventId?: string,
    occurredAt = new Date().toISOString()
  ) {
    const command = this.commandContext.getStore();
    const correlatedCommandId = commandId
      ?? (command?.sessionId === notification.sessionId ? command.commandId : undefined);
    if (!correlatedCommandId) return;
    this.record(notification, correlatedCommandId, eventId, occurredAt);
  }

  read(sessionId: string) {
    return [...(this.eventsBySession.get(sessionId) ?? [])];
  }

  subscribe(sessionId: string, listener: PublicEventListener) {
    const listeners = this.listenersBySession.get(sessionId) ?? new Set();
    listeners.add(listener);
    this.listenersBySession.set(sessionId, listeners);
    return () => listeners.delete(listener);
  }

  close() {
    this.listenersBySession.clear();
  }

  private record(
    notification: AgentNotification,
    commandId: string,
    eventId: string | undefined,
    occurredAt: string
  ) {
    const event = this.projector.project(notification);
    if (!event) return;
    const sessionEvents = this.eventsBySession.get(event.sessionId) ?? [];
    const publicEvent: PublicAgentEvent = {
      eventId: eventId ?? randomUUID(),
      sequence: sessionEvents.length + 1,
      sessionId: event.sessionId,
      commandId,
      type: event.type,
      occurredAt,
      payload: eventPayload(event)
    };
    sessionEvents.push(publicEvent);
    this.eventsBySession.set(event.sessionId, sessionEvents);
    for (const listener of this.listenersBySession.get(event.sessionId) ?? []) listener(publicEvent);
  }
}

function eventPayload(event: { type: string; sessionId: string } & Record<string, unknown>) {
  const value: Record<string, unknown> = { ...event };
  delete value.type;
  delete value.sessionId;
  return value;
}
