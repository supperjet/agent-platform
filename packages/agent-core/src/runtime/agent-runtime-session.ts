import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import {
  AgentRuntime,
  type AgentConversationState,
  type AgentExecutionOutcome,
  type AgentRuntimeCommand,
  type AgentRuntimeEventListener,
} from "../contracts.js";
import type { ConversationRuntimeState } from "../conversation/conversation-store.js";
import type { LifecycleRunner } from "../lifecycle/lifecycle-runner.js";
import type { ToolRuntimeEvent } from "../tools/tool-runtime.js";
import type { AgentLoop, AgentLoopSnapshot } from "./agent-loop.js";
import { EventHub } from "./event-hub.js";
import { StateExporter } from "./state-exporter.js";
import { TurnRunner } from "./turn-runner.js";

/**
 * 单个 Agent 会话的运行时对象。
 *
 * AgentRuntimeSession 是 core 对外的 Runtime 实例：
 * - 对下持有 AgentLoop，驱动底层 agent 执行。
 * - 对内通过 EventHub 维护公共事件流和执行 outcome。
 * - 对内通过 StateExporter 把底层消息快照同步成可恢复会话状态。
 * - 对外实现 AgentRuntime 的 execute/snapshot/exportState/subscribe。
 */
export class AgentRuntimeSession extends AgentRuntime {
  private readonly eventHub: EventHub;
  private readonly stateExporter: StateExporter;
  private readonly turnRunner: TurnRunner;
  private readonly messageOverrides = new Map<number, AgentMessage>();
  private readonly pendingLoopEvents: AgentEvent[] = [];
  private isDrainingLoopEvents = false;
  private drainLoopEventsPromise: Promise<void> = Promise.resolve();
  private eventProcessingError: unknown;
  private nextMessageIndex: number;

  constructor(
    private readonly sessionId: string,
    private readonly loop: AgentLoop,
    conversation: ConversationRuntimeState,
    initialMessageSequence = 0,
    preferToolRuntimeEvents = false,
    private readonly lifecycleRunner?: LifecycleRunner,
    systemPrompt?: string,
  ) {
    super();
    // 创建事件中心
    this.eventHub = new EventHub({
      sessionId,
      initialMessageSequence,
      preferToolRuntimeEvents,
    });

    // 创建状态导出器
    this.stateExporter = new StateExporter({ sessionId, conversation });
    this.nextMessageIndex = initialMessageSequence;

    // 创建回合运行器
    this.turnRunner = new TurnRunner({
      loop: this.loop,
      readExecutionOutcome: () => this.eventHub.readExecutionOutcome(),
      afterTurn: async () => {
        await this.flushLoopEvents();
        this.stateExporter.syncFromSnapshot(this.readLifecycleSnapshot());
      },
      ...(this.lifecycleRunner ? { lifecycleRunner: this.lifecycleRunner } : {}),
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    });

    // 订阅底层 loop 事件，并交给 EventHub 转成 AgentRuntimeEvent。
    this.loop.subscribe((event) => {
      this.enqueueLoopEvent(event);
    });
  }

  /**
   * 接收 ToolRuntime 内部生命周期事件。
   *
   * Factory/Assembler 会把这个方法作为桥接点传给工具 wrapper，
   * EventHub 再把内部事件转换成公共工具事件。
   */
  publishToolRuntimeEvent(event: ToolRuntimeEvent) {
    this.eventHub.publishToolRuntimeEvent(event);
  }

  /** 执行一次外部 runtime 命令。 */
  async execute(command: AgentRuntimeCommand): Promise<AgentExecutionOutcome> {
    return this.turnRunner.run(command);
  }

  /** 读取面向调用方的轻量 runtime 快照。 */
  snapshot() {
    const snapshot = this.readLifecycleSnapshot();
    return {
      messageCount: snapshot.messages.length,
      transcriptRoles: snapshot.messages.map((message) => message.role),
      isRunning: snapshot.isStreaming,
      modelId: snapshot.modelId,
    };
  }

  /** 导出可恢复会话状态；会先把最新 loop snapshot 同步到 entry graph。 */
  exportState(): AgentConversationState {
    return this.stateExporter.exportState(this.readLifecycleSnapshot());
  }

  /** 订阅公共 AgentRuntimeEvent。 */
  subscribe(listener: AgentRuntimeEventListener) {
    return this.eventHub.subscribe(listener);
  }

  /**
   * 底层 loop 的事件是同步推送的，但 afterMessage hook 可能是异步的。
   * 这里显式维护一个 FIFO 队列，让事件按收到顺序逐个处理。
   */
  private enqueueLoopEvent(event: AgentEvent) {
    this.pendingLoopEvents.push(event);
    if (!this.isDrainingLoopEvents) {
      this.drainLoopEventsPromise = this.drainLoopEvents();
    }
  }

  private async drainLoopEvents() {
    this.isDrainingLoopEvents = true;
    try {
      while (this.pendingLoopEvents.length > 0) {
        const event = this.pendingLoopEvents.shift();
        if (!event) continue;
        try {
          await this.processLoopEvent(event);
        } catch (error) {
          this.eventProcessingError ??= error;
        }
      }
    } finally {
      this.isDrainingLoopEvents = false;
    }
  }

  private async processLoopEvent(event: AgentEvent) {
    if (event.type !== "message_end") {
      this.eventHub.publishAgentEvent(event);
      return;
    }

    const messageIndex = this.nextMessageIndex;
    this.nextMessageIndex += 1;
    const hookResult = await this.lifecycleRunner?.afterMessage({
      message: event.message,
    });
    const message = hookResult?.message ?? event.message;
    if (message !== event.message) {
      assertSameMessageRole(event.message, message);
      this.messageOverrides.set(messageIndex, message);
    }

    this.eventHub.publishAgentEvent({
      ...event,
      message,
    } as AgentEvent);
  }

  private async flushLoopEvents() {
    await this.drainLoopEventsPromise;
    if (this.eventProcessingError) {
      const error = this.eventProcessingError;
      this.eventProcessingError = undefined;
      throw error;
    }
  }

  private readLifecycleSnapshot(): AgentLoopSnapshot {
    const snapshot = this.loop.snapshot();
    if (this.messageOverrides.size === 0) return snapshot;
    return {
      ...snapshot,
      messages: snapshot.messages.map((message, index) =>
        this.messageOverrides.get(index) ?? message,
      ),
    };
  }
}

function assertSameMessageRole(original: AgentMessage, replacement: AgentMessage) {
  if (original.role !== replacement.role) {
    throw new Error("afterMessage cannot change message role.");
  }
}
