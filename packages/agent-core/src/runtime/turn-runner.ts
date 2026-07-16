import {
  type AgentExecutionOutcome,
  type AgentRuntimeCommand
} from "../contracts.js";
import type { AgentLoop } from "./agent-loop.js";
import { createUserMessage } from "./messages.js";

/**
 * TurnRunner 运行一个命令所需的依赖。
 */
export type TurnRunnerOptions = {
  /** 底层 agent 执行循环。 */
  loop: AgentLoop;
  /** 从 EventHub 读取最近一次 prompt run 的 outcome。 */
  readExecutionOutcome: () => AgentExecutionOutcome;
  /** 每次会改变消息历史的命令之后调用，通常用于同步 StateExporter。 */
  afterTurn?: () => void;
};

/**
 * 回合运行器。
 *
 * TurnRunner 把公共 AgentRuntimeCommand 翻译成 AgentLoop 操作：
 * - prompt：发送用户消息，等待底层 agent idle，然后返回 EventHub 记录的 outcome。
 * - steer/follow-up：只把控制消息交给 loop，立即返回 succeeded。
 * - abort：请求中止当前执行。
 */
export class TurnRunner {
  constructor(private readonly options: TurnRunnerOptions) {}

  async run(command: AgentRuntimeCommand): Promise<AgentExecutionOutcome> {
    if (command.type === "prompt") {
      // prompt 是完整回合：需要等待底层执行结束，再同步状态和读取 outcome。
      await this.options.loop.prompt(createUserMessage(command.text));
      await this.options.loop.waitForIdle();
      this.options.afterTurn?.();
      return this.options.readExecutionOutcome();
    }
    if (command.type === "steer") {
      // steer 是运行中控制命令，不等待 idle。
      this.options.loop.steer(createUserMessage(command.text));
      this.options.afterTurn?.();
      return { status: "succeeded" };
    }
    if (command.type === "follow-up") {
      // follow-up 追加后续用户意图，底层 loop 决定实际执行时机。
      this.options.loop.followUp(createUserMessage(command.text));
      this.options.afterTurn?.();
      return { status: "succeeded" };
    }
    // abort 不一定立刻让底层 agent 停止；这里只表示中止请求已发出。
    this.options.loop.abort();
    return { status: "succeeded" };
  }
}
