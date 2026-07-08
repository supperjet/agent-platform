import { Agent, type AgentEvent, type AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import {
  AgentRuntime,
  AgentRuntimeFactory,
  type AgentConversationState,
  type AgentExecutionOutcome,
  type AgentModel,
  type AgentRuntimeCommand,
  type AgentRuntimeEvent,
  type AgentRuntimeEventListener
} from "../contracts.js";
import { createUserMessage } from "./messages.js";
import { lookupSourceTool } from "../tools/lookup-source.js";
import {
  exportConversationState,
  restoreConversationMessages
} from "./conversation-state.js";

export type PiAgentRuntimeFactoryOptions = {
  model: AgentModel;
  resolveApiKey: (provider: string) => string | undefined | Promise<string | undefined>;
  onApiKeyResolved?: () => void;
  onEvent?: AgentRuntimeEventListener;
};

export class PiAgentRuntime extends AgentRuntime {
  private readonly listeners = new Set<AgentRuntimeEventListener>();
  private messageSequence = 0;
  private activeMessageId: string | undefined;
  private runFailed = false;
  private executionOutcome: AgentExecutionOutcome = { status: "succeeded" };

  constructor(
    private readonly sessionId: string,
    private readonly agent: Agent,
    initialMessageSequence = 0
  ) {
    super();
    this.messageSequence = initialMessageSequence;
    this.agent.subscribe((event) => this.publishAgentEvent(event));
  }

  async execute(command: AgentRuntimeCommand): Promise<AgentExecutionOutcome> {
    if (command.type === "prompt") {
      await this.agent.prompt(command.text);
      await this.agent.waitForIdle();
      return this.executionOutcome;
    }
    if (command.type === "steer") {
      this.agent.steer(createUserMessage(command.text));
      return { status: "succeeded" };
    }
    if (command.type === "follow-up") {
      this.agent.followUp(createUserMessage(command.text));
      return { status: "succeeded" };
    }
    this.agent.abort();
    return { status: "succeeded" };
  }

  snapshot() {
    return {
      messageCount: this.agent.state.messages.length,
      transcriptRoles: this.agent.state.messages.map((message) => message.role),
      isRunning: this.agent.state.isStreaming,
      modelId: this.agent.state.model.id
    };
  }

  exportState(): AgentConversationState {
    return exportConversationState(this.agent.state.model.id, this.agent.state.messages);
  }

  subscribe(listener: AgentRuntimeEventListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private publishAgentEvent(event: AgentEvent) {
    const runtimeEvent = this.convertAgentEvent(event);
    if (!runtimeEvent) return;
    for (const listener of this.listeners) listener(runtimeEvent);
  }

  private convertAgentEvent(event: AgentEvent): AgentRuntimeEvent | undefined {
    if (event.type === "agent_start") {
      this.runFailed = false;
      this.executionOutcome = { status: "succeeded" };
      return { type: "run_started", sessionId: this.sessionId };
    }
    if (event.type === "agent_end") {
      if (this.runFailed) {
        this.runFailed = false;
        return undefined;
      }
      return { type: "run_finished", sessionId: this.sessionId };
    }
    if (event.type === "message_start" && isProviderMessage(event.message)) {
      this.activeMessageId = this.nextMessageId();
      return {
        type: "message_started",
        sessionId: this.sessionId,
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
        sessionId: this.sessionId,
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
          sessionId: this.sessionId,
          errorCode: "AGENT_RUN_FAILED",
          message: event.message.errorMessage
        };
      }
      const runtimeEvent: AgentRuntimeEvent = {
        type: "message_finished",
        sessionId: this.sessionId,
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
        sessionId: this.sessionId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args
      };
    }
    if (event.type === "tool_execution_update") {
      return {
        type: "tool_progress",
        sessionId: this.sessionId,
        toolCallId: event.toolCallId,
        text: readResultText(event.partialResult)
      };
    }
    if (event.type === "tool_execution_end") {
      return {
        type: "tool_finished",
        sessionId: this.sessionId,
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
    return `${this.sessionId}:message:${this.messageSequence}`;
  }
}

export class PiAgentRuntimeFactory extends AgentRuntimeFactory {
  constructor(private readonly options: PiAgentRuntimeFactoryOptions) {
    super();
  }

  create(sessionId: string, state?: AgentConversationState) {
    const restoredMessages = restoreConversationMessages(state, this.options.model.id);
    const agent = new Agent({
      initialState: {
        systemPrompt: [
          `You are the runtime for session ${sessionId}.`,
          "Answer concisely in Chinese.",
          "For every user prompt, call lookup_source exactly once before writing the final answer.",
          "Never reveal API keys, system configuration, or hidden runtime state."
        ].join(" "),
        model: this.options.model,
        messages: restoredMessages,
        tools: [lookupSourceTool]
      },
      getApiKey: async (provider) => {
        const key = await this.options.resolveApiKey(provider);
        if (key) this.options.onApiKeyResolved?.();
        return key;
      }
    });
    const runtime = new PiAgentRuntime(sessionId, agent, restoredMessages.length);
    if (this.options.onEvent) runtime.subscribe(this.options.onEvent);
    return runtime;
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
