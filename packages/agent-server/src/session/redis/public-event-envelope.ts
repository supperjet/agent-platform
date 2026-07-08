import type { AgentNotification } from "../../messaging/events.js";

export const PUBLIC_EVENT_STREAM_KEY = "agent-platform:public-events:v1";
export const PUBLIC_EVENT_STREAM_FIELD = "event";

export type PublicEventEnvelope = {
  version: 1;
  commandId: string;
  notification: AgentNotification;
};

export function encodePublicEventEnvelope(envelope: PublicEventEnvelope) {
  return JSON.stringify(envelope);
}

export function decodePublicEventEnvelope(message: string): PublicEventEnvelope | undefined {
  try {
    const value: unknown = JSON.parse(message);
    if (!isRecord(value) || value.version !== 1 || typeof value.commandId !== "string") return undefined;
    if (!isRecord(value.notification) || typeof value.notification.sessionId !== "string") return undefined;
    return value as PublicEventEnvelope;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
