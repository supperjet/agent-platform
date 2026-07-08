import type { AgentRuntimeEvent } from "@agent-platform/agent-core";

export type AgentNotification = AgentRuntimeEvent;

export type AgentNotificationListener = (event: AgentNotification) => void;
export type Unsubscribe = () => void;
