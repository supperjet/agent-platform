import type { Model } from "@earendil-works/pi-ai";
import type {
  ConversationEntry,
  ConversationEntryId,
} from "./conversation/conversation-entry.js";

export type AgentModel = Model<any>;

export type AgentRuntimeCommand =
  | { type: "prompt"; text: string }
  | { type: "steer"; text: string }
  | { type: "follow-up"; text: string }
  | { type: "compact"; reason?: "manual"; keepLastMessages?: number }
  | { type: "abort" };

export type AgentRuntimeSnapshot = {
  messageCount: number;
  transcriptRoles: string[];
  isRunning: boolean;
  modelId: string;
};

export type AgentRuntimeContextSnapshot = {
  systemPrompt: string;
  messages: Array<{
    scope: "conversation" | "persistent" | "transient" | "unknown";
    role: string;
    text: string;
  }>;
  metadata?: Record<string, unknown>;
  diagnostics: {
    budget: unknown;
    injectedSources: string[];
    persistentPromptMessageCount: number;
    transientPromptMessageCount: number;
  };
};

/** Versioned, serializable state required to resume one Agent conversation. */
export type AgentConversationState = {
  schemaVersion: 2;
  modelId: string;
  payload: {
    entries: readonly ConversationEntry[];
    leafId: ConversationEntryId | null;
  };
};

export type AgentExecutionOutcome =
  | { status: "succeeded" }
  | { status: "aborted" }
  | { status: "commit_failed"; errorCode: string; message: string }
  | { status: "failed"; errorCode: string; message: string };

export type AgentMessageRole = "user" | "assistant" | "toolResult";
export type AgentRuntimeMessageScope = "persistent" | "transient" | "unknown";

export type AgentRuntimeEvent =
  | { type: "run_started"; sessionId: string }
  | { type: "run_finished"; sessionId: string }
  | { type: "run_aborted"; sessionId: string }
  | { type: "run_failed"; sessionId: string; errorCode: "AGENT_RUN_FAILED"; message: string }
  | { type: "message_started"; sessionId: string; messageId: string; role: AgentMessageRole; text: string; messageScope: AgentRuntimeMessageScope }
  | { type: "message_delta"; sessionId: string; messageId: string; channel: "text" | "thinking"; delta: string }
  | { type: "message_finished"; sessionId: string; messageId: string; role: AgentMessageRole; text: string; messageScope: AgentRuntimeMessageScope }
  | { type: "tool_started"; sessionId: string; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_policy_checked"; sessionId: string; toolCallId: string; toolName: string; decision: string; reason?: string }
  | { type: "tool_approval_requested"; sessionId: string; toolCallId: string; toolName: string; title: string; message: string; risk?: "low" | "medium" | "high"; reason: string }
  | { type: "tool_approval_approved"; sessionId: string; toolCallId: string; toolName: string }
  | { type: "tool_approval_denied"; sessionId: string; toolCallId: string; toolName: string; reason: string }
  | { type: "tool_progress"; sessionId: string; toolCallId: string; text: string }
  | { type: "tool_finished"; sessionId: string; toolCallId: string; isError: boolean; text: string; sourceIds: string[] };

export type AgentRuntimeEventListener = (event: AgentRuntimeEvent) => void;

export abstract class AgentRuntime {
  abstract execute(command: AgentRuntimeCommand): Promise<AgentExecutionOutcome>;
  abstract snapshot(): AgentRuntimeSnapshot;
  inspectContext(): AgentRuntimeContextSnapshot | undefined {
    return undefined;
  }
  abstract exportState(): AgentConversationState;
  abstract subscribe(listener: AgentRuntimeEventListener): () => void;
}

export abstract class AgentRuntimeFactory {
  abstract create(sessionId: string, state?: AgentConversationState): AgentRuntime;
}
