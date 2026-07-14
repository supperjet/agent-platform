import {
  type AgentExecutionOutcome,
  type AgentRuntimeCommand
} from "../contracts.js";
import type { AgentLoop } from "./agent-loop.js";
import { createUserMessage } from "./messages.js";

export type TurnRunnerOptions = {
  loop: AgentLoop;
  readExecutionOutcome: () => AgentExecutionOutcome;
  afterTurn?: () => void;
};

/**
 * 回合运行器
 * 负责执行Agent运行时命令，并返回执行结果
 */

export class TurnRunner {
  constructor(private readonly options: TurnRunnerOptions) {}

  async run(command: AgentRuntimeCommand): Promise<AgentExecutionOutcome> {
    if (command.type === "prompt") {
      await this.options.loop.prompt(createUserMessage(command.text));
      await this.options.loop.waitForIdle();
      this.options.afterTurn?.();
      return this.options.readExecutionOutcome();
    }
    if (command.type === "steer") {
      this.options.loop.steer(createUserMessage(command.text));
      this.options.afterTurn?.();
      return { status: "succeeded" };
    }
    if (command.type === "follow-up") {
      this.options.loop.followUp(createUserMessage(command.text));
      this.options.afterTurn?.();
      return { status: "succeeded" };
    }
    this.options.loop.abort();
    return { status: "succeeded" };
  }
}
