import type { Model } from "@earendil-works/pi-ai";

export type AgentModel = Model<any>;

export type AgentRuntimeCommand =
  | { type: "prompt"; text: string }
  | { type: "steer"; text: string }
  | { type: "follow-up"; text: string }
  | { type: "abort" };

export type AgentRuntimeSnapshot = {
  messageCount: number;
  transcriptRoles: string[];
  isRunning: boolean;
  modelId: string;
};

/** Versioned, serializable state required to resume one Agent conversation. */
export type AgentConversationState = {
  schemaVersion: 1;
  modelId: string;
  payload: unknown;
};

export type AgentExecutionOutcome =
  | { status: "succeeded" }
  | { status: "failed"; errorCode: string; message: string };

export type AgentMessageRole = "user" | "assistant" | "toolResult";

export type AgentRuntimeEvent =
  | { type: "run_started"; sessionId: string }
  | { type: "run_finished"; sessionId: string }
  | { type: "run_failed"; sessionId: string; errorCode: "AGENT_RUN_FAILED"; message: string }
  | { type: "message_started"; sessionId: string; messageId: string; role: AgentMessageRole; text: string }
  | { type: "message_delta"; sessionId: string; messageId: string; channel: "text" | "thinking"; delta: string }
  | { type: "message_finished"; sessionId: string; messageId: string; role: AgentMessageRole; text: string }
  | { type: "tool_started"; sessionId: string; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_progress"; sessionId: string; toolCallId: string; text: string }
  | { type: "tool_finished"; sessionId: string; toolCallId: string; isError: boolean; text: string; sourceIds: string[] };

export type AgentRuntimeEventListener = (event: AgentRuntimeEvent) => void;

export abstract class AgentRuntime {
  abstract execute(command: AgentRuntimeCommand): Promise<AgentExecutionOutcome>;
  abstract snapshot(): AgentRuntimeSnapshot;
  abstract exportState(): AgentConversationState;
  abstract subscribe(listener: AgentRuntimeEventListener): () => void;
}

export abstract class AgentRuntimeFactory {
  abstract create(sessionId: string, state?: AgentConversationState): AgentRuntime;
}
