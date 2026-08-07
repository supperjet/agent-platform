import type { AgentEvent, AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";

export type AgentLoopPromptOptions = {
  /** 仅作用于本次 prompt run 的 system prompt override。 */
  systemPrompt?: string;
  /** 仅作用于本次 prompt run 的工具集合 override。 */
  tools?: readonly AgentTool[];
};

/**
 * AgentLoop 的最小状态快照。
 *
 * 这是 agent-core 自己定义的抽象快照，不直接暴露 pi-agent-core 的完整内部状态。
 * RuntimeSession 和 StateExporter 只依赖这些字段，就能完成 UI 状态展示和会话导出。
 */
export type AgentLoopSnapshot = {
  /** 当前 loop 内完整消息历史。 */
  messages: readonly AgentMessage[];
  /** 底层 agent 是否仍在流式执行。 */
  isStreaming: boolean;
  /** 当前会话绑定的模型 ID，用于恢复状态时做兼容性校验。 */
  modelId: string;
};

/**
 * agent-core 对底层 agent 执行循环的最小抽象。
 *
 * 这一层的意义是隔离具体 Agent 实现：当前由 pi-agent-core 驱动，
 * 但 RuntimeSession / TurnRunner / StateExporter 不需要知道底层类名和构造细节。
 */
export type AgentLoop = {
  /** 发送用户 prompt，并启动一次 agent 回合。 */
  prompt(message: AgentMessage | AgentMessage[], options?: AgentLoopPromptOptions): Promise<void>;
  /** 让底层 agent 从当前状态继续执行。 */
  continue(): Promise<void>;
  /** 在运行中插入 steering 消息，影响当前执行方向。 */
  steer(message: AgentMessage): void;
  /** 排队一个后续用户消息，通常在当前回合结束后继续执行。 */
  followUp(message: AgentMessage): void;
  /** 请求中止当前执行。 */
  abort(): void;
  /** 等到底层 agent 空闲，通常用于 prompt 后等待完整回合结束。 */
  waitForIdle(): Promise<void>;
  /** 订阅底层 AgentEvent；EventHub 会把它转换成 agent-core 公共事件。 */
  subscribe(listener: (event: AgentEvent) => void): () => void;
  /** 读取当前最小快照。 */
  snapshot(): AgentLoopSnapshot;
  /** 用调用方整理后的消息历史替换底层 loop history。 */
  replaceMessages(messages: readonly AgentMessage[]): void;
};
