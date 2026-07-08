import type { AgentNotification } from "../messaging/events.js";

export type BrowserAgentEvent =
  | { type: "run_started"; sessionId: string }
  | { type: "run_failed"; sessionId: string; errorCode: "AGENT_RUN_FAILED"; message: string }
  | { type: "message_started"; sessionId: string; messageId: string; role: "user" | "assistant"; text: string }
  | { type: "assistant_delta"; sessionId: string; messageId: string; delta: string }
  | { type: "message_finished"; sessionId: string; messageId: string; role: "user" | "assistant"; text: string }
  | { type: "tool_started"; sessionId: string; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_progress"; sessionId: string; toolCallId: string; text: string }
  | { type: "tool_finished"; sessionId: string; toolCallId: string; isError: boolean; text: string; sourceIds: string[] }
  | { type: "run_finished"; sessionId: string };

export abstract class BrowserEventProjector {
  abstract project(event: AgentNotification): BrowserAgentEvent | undefined;
}

/** Applies browser disclosure policy without leaking that policy into Agent or session layers. */
export class DefaultBrowserEventProjector extends BrowserEventProjector {
  project(event: AgentNotification): BrowserAgentEvent | undefined {
    if (event.type === "message_delta") {
      return event.channel === "text"
        ? {
            type: "assistant_delta",
            sessionId: event.sessionId,
            messageId: event.messageId,
            delta: event.delta
          }
        : undefined;
    }

    if (event.type === "message_started" || event.type === "message_finished") {
      if (event.role !== "user" && event.role !== "assistant") {
        return undefined;
      }

      return { ...event, role: event.role };
    }

    return event;
  }
}
