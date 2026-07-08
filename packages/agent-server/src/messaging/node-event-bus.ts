import { EventEmitter } from "node:events";
import { SessionEventBus } from "./contracts.js";
import type { AgentNotification, AgentNotificationListener } from "./events.js";

const ALL_SESSIONS_TOPIC = "session:*";

/** Uses Node's battle-tested EventEmitter instead of implementing event dispatch manually. */
export class NodeSessionEventBus extends SessionEventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    super();
    this.emitter.setMaxListeners(0);
  }

  publish(event: AgentNotification) {
    this.emitter.emit(topicForSession(event.sessionId), event);
    this.emitter.emit(ALL_SESSIONS_TOPIC, event);
  }

  subscribe(sessionId: string, listener: AgentNotificationListener) {
    const topic = topicForSession(sessionId);
    this.emitter.on(topic, listener);
    return () => this.emitter.off(topic, listener);
  }

  subscribeAll(listener: AgentNotificationListener) {
    this.emitter.on(ALL_SESSIONS_TOPIC, listener);
    return () => this.emitter.off(ALL_SESSIONS_TOPIC, listener);
  }
}

function topicForSession(sessionId: string) {
  return `session:${sessionId}`;
}
