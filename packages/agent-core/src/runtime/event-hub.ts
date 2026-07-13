import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import {
  type AgentExecutionOutcome,
  type AgentRuntimeEvent,
  type AgentRuntimeEventListener
} from "../contracts.js";

export type EventHubOptions = {
  sessionId: string;
  initialMessageSequence?: number;
};

export class EventHub {
  private readonly listeners = new Set<AgentRuntimeEventListener>();
  private messageSequence: number;
  private activeMessageId: string | undefined;
  private runFailed = false;
  private executionOutcome: AgentExecutionOutcome = { status: "succeeded" };

  constructor(private readonly options: EventHubOptions) {
    this.messageSequence = options.initialMessageSequence ?? 0;
  }

  publishAgentEvent(event: AgentEvent) {
    const runtimeEvent = this.convertAgentEvent(event);
    if (!runtimeEvent) return;
    for (const listener of this.listeners) listener(runtimeEvent);
  }

  readExecutionOutcome(): AgentExecutionOutcome {
    return this.executionOutcome;
  }

  subscribe(listener: AgentRuntimeEventListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private convertAgentEvent(event: AgentEvent): AgentRuntimeEvent | undefined {
    if (event.type === "agent_start") {
      this.runFailed = false;
      this.executionOutcome = { status: "succeeded" };
      return { type: "run_started", sessionId: this.options.sessionId };
    }
    if (event.type === "agent_end") {
      if (this.runFailed) {
        this.runFailed = false;
        return undefined;
      }
      return { type: "run_finished", sessionId: this.options.sessionId };
    }
    if (event.type === "message_start" && isProviderMessage(event.message)) {
      this.activeMessageId = this.nextMessageId();
      return {
        type: "message_started",
        sessionId: this.options.sessionId,
        messageId: this.activeMessageId,
        role: event.message.role,
        text: readMessageText(event.message)
      };
    }
    if (event.type === "message_update" && this.activeMessageId) {
      const update = event.assistantMessageEvent;
      if (update.type !== "text_delta" && update.type !== "thinking_delta") return undefined;
      return {
        type: "message_delta",
        sessionId: this.options.sessionId,
        messageId: this.activeMessageId,
        channel: update.type === "text_delta" ? "text" : "thinking",
        delta: update.delta
      };
    }
    if (event.type === "message_end" && isProviderMessage(event.message) && this.activeMessageId) {
      if (event.message.role === "assistant" && event.message.errorMessage) {
        this.activeMessageId = undefined;
        this.runFailed = true;
        this.executionOutcome = {
          status: "failed",
          errorCode: "AGENT_RUN_FAILED",
          message: event.message.errorMessage
        };
        return {
          type: "run_failed",
          sessionId: this.options.sessionId,
          errorCode: "AGENT_RUN_FAILED",
          message: event.message.errorMessage
        };
      }
      const runtimeEvent: AgentRuntimeEvent = {
        type: "message_finished",
        sessionId: this.options.sessionId,
        messageId: this.activeMessageId,
        role: event.message.role,
        text: readMessageText(event.message)
      };
      this.activeMessageId = undefined;
      return runtimeEvent;
    }
    if (event.type === "tool_execution_start") {
      return {
        type: "tool_started",
        sessionId: this.options.sessionId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args
      };
    }
    if (event.type === "tool_execution_update") {
      return {
        type: "tool_progress",
        sessionId: this.options.sessionId,
        toolCallId: event.toolCallId,
        text: readResultText(event.partialResult)
      };
    }
    if (event.type === "tool_execution_end") {
      return {
        type: "tool_finished",
        sessionId: this.options.sessionId,
        toolCallId: event.toolCallId,
        isError: event.isError,
        text: readResultText(event.result),
        sourceIds: readSourceIds(event.result)
      };
    }
    return undefined;
  }

  private nextMessageId() {
    this.messageSequence += 1;
    return `${this.options.sessionId}:message:${this.messageSequence}`;
  }
}

function isProviderMessage(message: AgentMessage): message is Message {
  return message.role === "user" || message.role === "assistant" || message.role === "toolResult";
}

function readMessageText(message: Message) {
  if (typeof message.content === "string") return message.content;
  return message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
}

function readResultText(result: unknown) {
  if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content)) return "";
  return result.content.flatMap((block: unknown) => {
    if (block && typeof block === "object" && "type" in block && block.type === "text" && "text" in block) {
      return [String(block.text)];
    }
    return [];
  }).join("\n");
}

function readSourceIds(result: unknown) {
  if (!result || typeof result !== "object" || !("details" in result)) return [];
  const details = result.details;
  if (!details || typeof details !== "object" || !("sourceIds" in details) || !Array.isArray(details.sourceIds)) return [];
  return details.sourceIds.filter((sourceId): sourceId is string => typeof sourceId === "string");
}
