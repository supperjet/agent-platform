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
import type { AgentLoop } from "./agent-loop.js";
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

  constructor(
    private readonly sessionId: string,
    private readonly loop: AgentLoop,
    conversation: ConversationRuntimeState,
    initialMessageSequence = 0,
    preferToolRuntimeEvents = false,
    lifecycleRunner?: LifecycleRunner,
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

    // 创建回合运行器
    this.turnRunner = new TurnRunner({
      loop: this.loop,
      readExecutionOutcome: () => this.eventHub.readExecutionOutcome(),
      afterTurn: () =>
        this.stateExporter.syncFromSnapshot(this.loop.snapshot()),
      ...(lifecycleRunner ? { lifecycleRunner } : {}),
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    });

    // 订阅底层 loop 事件，并交给 EventHub 转成 AgentRuntimeEvent。
    this.loop.subscribe((event) => {
      if (event.type === "message_end") {
        void lifecycleRunner?.afterMessage({ message: event.message });
      }
      this.eventHub.publishAgentEvent(event);
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
    const snapshot = this.loop.snapshot();
    return {
      messageCount: snapshot.messages.length,
      transcriptRoles: snapshot.messages.map((message) => message.role),
      isRunning: snapshot.isStreaming,
      modelId: snapshot.modelId,
    };
  }

  /** 导出可恢复会话状态；会先把最新 loop snapshot 同步到 entry graph。 */
  exportState(): AgentConversationState {
    return this.stateExporter.exportState(this.loop.snapshot());
  }

  /** 订阅公共 AgentRuntimeEvent。 */
  subscribe(listener: AgentRuntimeEventListener) {
    return this.eventHub.subscribe(listener);
  }
}
