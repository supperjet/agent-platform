import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import {
  type AgentExecutionOutcome,
  type AgentRuntimeMessageScope,
  type AgentRuntimeEvent,
  type AgentRuntimeEventListener,
} from "../contracts.js";
import {
  ToolRuntimeEventType,
  type ToolRuntimeEvent,
} from "../tools/tool-runtime.js";

/**
 * EventHub 的会话级配置。
 */
export type EventHubOptions = {
  /** 当前 runtime session 的 ID，会写入所有公共事件。 */
  sessionId: string;
  /** 恢复会话时已有消息数量，用于继续生成稳定 messageId。 */
  initialMessageSequence?: number;
  /**
   * 是否优先使用 ToolRuntime 的工具生命周期事件。
   *
   * 为 true 时，EventHub 会忽略 pi-agent-core 的 tool_execution_* 事件，
   * 避免同一次工具调用在公共事件流里重复出现。
   */
  preferToolRuntimeEvents?: boolean;
};

export type AgentEventPublishOptions = {
  messageScope?: AgentRuntimeMessageScope;
};

/**
 * 事件中心。
 *
 * EventHub 是 runtime 内部事件到公共 AgentRuntimeEvent 的转换层：
 * - `publishAgentEvent(...)` 接收 pi-agent-core 的 AgentEvent。
 * - `publishToolRuntimeEvent(...)` 接收 agent-core ToolRuntime 的生命周期事件。
 * - `subscribe(...)` 对外发布稳定的 AgentRuntimeEvent。
 *
 * 它也维护一次 run 的 outcome，用于 TurnRunner 在 prompt 完成后返回执行结果。
 */
export class EventHub {
  private readonly listeners = new Set<AgentRuntimeEventListener>();
  private messageSequence: number;
  private activeMessageId: string | undefined;
  private runFailed = false;
  private executionOutcome: AgentExecutionOutcome = { status: "succeeded" };

  constructor(private readonly options: EventHubOptions) {
    this.messageSequence = options.initialMessageSequence ?? 0;
  }

  /** 接收底层 AgentLoop 事件，并转换成公共 runtime 事件。 */
  publishAgentEvent(event: AgentEvent, options: AgentEventPublishOptions = {}) {
    const runtimeEvent = this.convertAgentEvent(event, options);
    if (!runtimeEvent) return;
    for (const listener of this.listeners) listener(runtimeEvent);
  }

  /** 接收 ToolRuntime 生命周期事件，并转换成公共工具事件。 */
  publishToolRuntimeEvent(event: ToolRuntimeEvent) {
    const runtimeEvent = this.convertToolRuntimeEvent(event);
    if (!runtimeEvent) return;
    for (const listener of this.listeners) listener(runtimeEvent);
  }

  /** 发布 session-level abort terminal 事件。 */
  publishRunAborted() {
    const runtimeEvent: AgentRuntimeEvent = {
      type: "run_aborted",
      sessionId: this.options.sessionId,
    };
    for (const listener of this.listeners) listener(runtimeEvent);
  }

  /** 读取最近一次 run 的结构化执行结果。 */
  readExecutionOutcome(): AgentExecutionOutcome {
    return this.executionOutcome;
  }

  /** 订阅公共事件；返回取消订阅函数。 */
  subscribe(listener: AgentRuntimeEventListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * 将 pi-agent-core 的 AgentEvent 转换成 agent-core 公共事件。
   *
   * message/run 事件始终来自 pi-agent-core；工具事件是否使用这里的转换，
   * 由 `preferToolRuntimeEvents` 控制。
   */
  private convertAgentEvent(
    event: AgentEvent,
    options: AgentEventPublishOptions,
  ): AgentRuntimeEvent | undefined {
    if (event.type === "agent_start") {
      // 每次 agent_start 都重置 run outcome。
      this.runFailed = false;
      this.executionOutcome = { status: "succeeded" };
      return { type: "run_started", sessionId: this.options.sessionId };
    }
    if (event.type === "agent_end") {
      // 如果 message_end 已经发布 run_failed，就不要再补一个 run_finished。
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
        text: readMessageText(event.message),
        messageScope: options.messageScope ?? "persistent",
      };
    }
    if (event.type === "message_update" && this.activeMessageId) {
      const update = event.assistantMessageEvent;
      // 当前公共协议只暴露文本和 thinking 的增量。
      if (update.type !== "text_delta" && update.type !== "thinking_delta")
        return undefined;
      return {
        type: "message_delta",
        sessionId: this.options.sessionId,
        messageId: this.activeMessageId,
        channel: update.type === "text_delta" ? "text" : "thinking",
        delta: update.delta,
      };
    }
    if (
      event.type === "message_end" &&
      isProviderMessage(event.message) &&
      this.activeMessageId
    ) {
      if (event.message.role === "assistant" && event.message.errorMessage) {
        // assistant 消息结束时带 errorMessage，表示这次 run 失败。
        this.activeMessageId = undefined;
        this.runFailed = true;
        this.executionOutcome = {
          status: "failed",
          errorCode: "AGENT_RUN_FAILED",
          message: event.message.errorMessage,
        };
        return {
          type: "run_failed",
          sessionId: this.options.sessionId,
          errorCode: "AGENT_RUN_FAILED",
          message: event.message.errorMessage,
        };
      }
      const runtimeEvent: AgentRuntimeEvent = {
        type: "message_finished",
        sessionId: this.options.sessionId,
        messageId: this.activeMessageId,
        role: event.message.role,
        text: readMessageText(event.message),
        messageScope: options.messageScope ?? "persistent",
      };
      this.activeMessageId = undefined;
      return runtimeEvent;
    }
    if (event.type === "tool_execution_start") {
      // 真实 RuntimeSession 会优先使用 ToolRuntime 事件，避免重复公共工具事件。
      if (this.options.preferToolRuntimeEvents) return undefined;
      return {
        type: "tool_started",
        sessionId: this.options.sessionId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
      };
    }
    if (event.type === "tool_execution_update") {
      // pi-agent-core 的 partial result 只投影为公共 tool_progress text。
      if (this.options.preferToolRuntimeEvents) return undefined;
      return {
        type: "tool_progress",
        sessionId: this.options.sessionId,
        toolCallId: event.toolCallId,
        text: readResultText(event.partialResult),
      };
    }
    if (event.type === "tool_execution_end") {
      // 兼容没有 ToolRuntime 桥接的测试或替代 AgentLoop。
      if (this.options.preferToolRuntimeEvents) return undefined;
      return {
        type: "tool_finished",
        sessionId: this.options.sessionId,
        toolCallId: event.toolCallId,
        isError: event.isError,
        text: readResultText(event.result),
        sourceIds: readSourceIds(event.result),
      };
    }
    return undefined;
  }

  /**
   * 将 ToolRuntime 内部生命周期事件转换成公共工具事件。
   *
   * 这里是 ToolRuntime -> EventHub -> AgentRuntimeEvent 的桥接点。
   * 对外仍保持 contracts.ts 中的公共事件协议，不暴露内部 runtime 类型。
   */
  private convertToolRuntimeEvent(
    event: ToolRuntimeEvent,
  ): AgentRuntimeEvent | undefined {
    if (event.type === ToolRuntimeEventType.Started) {
      return {
        type: "tool_started",
        sessionId: this.options.sessionId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
      };
    }
    if (event.type === ToolRuntimeEventType.PolicyChecked) {
      return {
        type: "tool_policy_checked",
        sessionId: this.options.sessionId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        decision: event.decision.type,
        ...(event.decision.reason ? { reason: event.decision.reason } : {}),
      };
    }
    if (event.type === ToolRuntimeEventType.ApprovalRequested) {
      return {
        type: "tool_approval_requested",
        sessionId: this.options.sessionId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        title: event.decision.approval.title,
        message: event.decision.approval.message,
        ...(event.decision.approval.risk ? { risk: event.decision.approval.risk } : {}),
        reason: event.decision.reason,
      };
    }
    if (event.type === ToolRuntimeEventType.ApprovalApproved) {
      return {
        type: "tool_approval_approved",
        sessionId: this.options.sessionId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
      };
    }
    if (event.type === ToolRuntimeEventType.ApprovalDenied) {
      return {
        type: "tool_approval_denied",
        sessionId: this.options.sessionId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        reason: event.reason,
      };
    }
    if (event.type === ToolRuntimeEventType.Updated) {
      return {
        type: "tool_progress",
        sessionId: this.options.sessionId,
        toolCallId: event.toolCallId,
        text: readResultText(event.result),
      };
    }
    if (event.type === ToolRuntimeEventType.Finished) {
      return {
        type: "tool_finished",
        sessionId: this.options.sessionId,
        toolCallId: event.toolCallId,
        isError: event.status !== "succeeded",
        text: event.result
          ? readResultText(event.result)
          : event.error?.message ?? "",
        sourceIds: event.result ? readSourceIds(event.result) : [],
      };
    }
    return undefined;
  }

  /** 为 provider/user/toolResult 消息生成会话内稳定递增的 messageId。 */
  private nextMessageId() {
    this.messageSequence += 1;
    return `${this.options.sessionId}:message:${this.messageSequence}`;
  }
}

/** 判断底层 AgentMessage 是否能作为 provider-neutral Message 投影给公共事件。 */
function isProviderMessage(message: AgentMessage): message is Message {
  return (
    message.role === "user" ||
    message.role === "assistant" ||
    message.role === "toolResult"
  );
}

/** 从 Message 的 content blocks 中提取纯文本，供公共 message 事件使用。 */
function readMessageText(message: Message) {
  if (typeof message.content === "string") return message.content;
  return message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n");
}

/** 从工具结果或 partial result 中提取文本内容。 */
function readResultText(result: unknown) {
  if (
    !result ||
    typeof result !== "object" ||
    !("content" in result) ||
    !Array.isArray(result.content)
  )
    return "";
  return result.content
    .flatMap((block: unknown) => {
      if (
        block &&
        typeof block === "object" &&
        "type" in block &&
        block.type === "text" &&
        "text" in block
      ) {
        return [String(block.text)];
      }
      return [];
    })
    .join("\n");
}

/** 从工具结果 details.sourceIds 中提取 source id 列表。 */
function readSourceIds(result: unknown) {
  if (!result || typeof result !== "object" || !("details" in result))
    return [];
  const details = result.details;
  if (
    !details ||
    typeof details !== "object" ||
    !("sourceIds" in details) ||
    !Array.isArray(details.sourceIds)
  )
    return [];
  return details.sourceIds.filter(
    (sourceId): sourceId is string => typeof sourceId === "string",
  );
}
