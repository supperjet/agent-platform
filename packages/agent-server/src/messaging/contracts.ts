import type { AgentNotification, AgentNotificationListener, Unsubscribe } from "./events.js";

// SessionEventBus, 事件总线，用于发布和订阅事件
export abstract class SessionEventBus {
  abstract publish(event: AgentNotification): void;
  abstract subscribe(sessionId: string, listener: AgentNotificationListener): Unsubscribe;
  abstract subscribeAll(listener: AgentNotificationListener): Unsubscribe;
}
