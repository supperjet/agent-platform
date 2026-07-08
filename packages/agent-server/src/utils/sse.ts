import type { PublicAgentEvent } from "../consumer/contracts.js";

type WritableSseStream = {
  destroyed: boolean;
  write(chunk: string): unknown;
};

export function sseHeaders() {
  return {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  };
}

export function serializeSse(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function serializePublicEvent(event: PublicAgentEvent) {
  return `id: ${event.eventId}\n${serializeSse(event.type, event)}`;
}

export function startHeartbeat(stream: WritableSseStream) {
  return setInterval(() => {
    if (!stream.destroyed) stream.write(": heartbeat\n\n");
  }, 15_000);
}
