import { Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/base";
import type { AgentModel } from "../contracts.js";
import type { AgentLoop, AgentLoopPromptOptions, AgentLoopSnapshot } from "./agent-loop.js";

/**
 * 创建 pi-agent-core Agent 所需的装配结果。
 *
 * RuntimeAssembler 会先把 definition/resources/tools/model/conversation 组装好，
 * Adapter 只负责把这些结果塞进底层 Agent。
 */
export type AgentLoopAdapterOptions = {
  systemPrompt: string;
  model: AgentModel;
  messages: readonly AgentMessage[];
  tools: readonly AgentTool[];
  getApiKey: (provider: string) => Promise<string | undefined>;
  /** Provider HTTP request timeout in milliseconds. */
  requestTimeoutMs?: number;
};

/**
 * pi-agent-core Agent 到 agent-core AgentLoop 抽象的适配器。
 *
 * 这里是 agent-core 与 pi-agent-core 的主要边界之一：
 * - 对上实现 `AgentLoop`，供 RuntimeSession / TurnRunner 使用。
 * - 对下持有真正的 `Agent` 实例，并转发 prompt、abort、subscribe 等能力。
 */
export class AgentLoopAdapter implements AgentLoop {
  private readonly agent: Agent;

  constructor(options: AgentLoopAdapterOptions) {
    const requestTimeoutMs = options.requestTimeoutMs;
    // 用已装配好的 system prompt、模型、消息和工具创建底层执行循环。
    this.agent = new Agent({
      initialState: {
        systemPrompt: options.systemPrompt,
        model: options.model,
        messages: [...options.messages],
        tools: [...options.tools]
      },
      getApiKey: options.getApiKey,
      ...(requestTimeoutMs === undefined
        ? {}
        : {
            streamFn: (model, context, streamOptions) =>
              streamSimple(model, context, {
                ...streamOptions,
                timeoutMs: requestTimeoutMs,
              }),
          })
    });
  }

  async prompt(message: AgentMessage | AgentMessage[], options: AgentLoopPromptOptions = {}): Promise<void> {
    // prompt 会启动一次底层 agent 执行。systemPrompt override 只作用于本次 run。
    const previousSystemPrompt = this.agent.state.systemPrompt;
    if (options.systemPrompt !== undefined) {
      this.agent.state.systemPrompt = options.systemPrompt;
    }
    try {
      await this.agent.prompt(message);
    } finally {
      if (options.systemPrompt !== undefined) {
        this.agent.state.systemPrompt = previousSystemPrompt;
      }
    }
  }

  async continue(): Promise<void> {
    // 继续当前 agent 状态，通常用于工具调用后或恢复执行。
    await this.agent.continue();
  }

  steer(message: AgentMessage): void {
    // steering 是运行中控制，不等待完整回合结束。
    this.agent.steer(message);
  }

  followUp(message: AgentMessage): void {
    // follow-up 是追加后续用户意图，由底层 agent 决定何时消费。
    this.agent.followUp(message);
  }

  abort(): void {
    // abort 只发出中止请求，实际终止由底层 Agent 协调。
    this.agent.abort();
  }

  async waitForIdle(): Promise<void> {
    // prompt 命令需要等待 idle 后，才能稳定读取 outcome 和快照。
    await this.agent.waitForIdle();
  }

  subscribe(listener: Parameters<Agent["subscribe"]>[0]): () => void {
    // 这里仍然暴露底层 AgentEvent，后续由 EventHub 统一转换。
    return this.agent.subscribe(listener);
  }

  snapshot(): AgentLoopSnapshot {
    // 只投影 agent-core 需要的最小状态，避免上层依赖底层 Agent 完整结构。
    return {
      messages: this.agent.state.messages,
      isStreaming: this.agent.state.isStreaming,
      modelId: this.agent.state.model.id
    };
  }

  replaceMessages(messages: readonly AgentMessage[]): void {
    this.agent.state.messages = [...messages];
  }
}
