import {
  type AgentExecutionOutcome,
  type AgentRuntimeCommand
} from "../contracts.js";
import type { LifecycleRunner } from "../lifecycle/lifecycle-runner.js";
import type { AgentLoop } from "./agent-loop.js";
import { createUserMessage } from "./messages.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

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
  /** 内部生命周期执行器；第一版用于输入、run/context 打点和运行结束通知。 */
  lifecycleRunner?: LifecycleRunner;
  /** 当前 session 的 base system prompt，传给 beforeRun / beforeContext。 */
  systemPrompt?: string;
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
    const inputResult = await this.options.lifecycleRunner?.onInput({ command });
    // 如果输入被生命周期处理者拦截，直接返回成功。（一些不需要进入大模型的命令）
    if (inputResult?.action === "handled") {
      await this.options.lifecycleRunner?.afterRun({ status: "succeeded" });
      return { status: "succeeded" };
    }
    // 
    const effectiveCommand = inputResult?.action === "transform"
      ? inputResult.command
      : command;

    if (effectiveCommand.type === "prompt") {
      // prompt 是完整回合：需要等待底层执行结束，再同步状态和读取 outcome。
      const userMessage = createUserMessage(effectiveCommand.text);
      let runSystemPrompt = this.options.systemPrompt ?? "";
      let promptMessages: AgentMessage[] = [userMessage];

      // 修改 system prompt 和 messages。
      const beforeRunResult = await this.options.lifecycleRunner?.beforeRun({
        command: effectiveCommand,
        systemPrompt: runSystemPrompt,
      });
      if (beforeRunResult?.systemPrompt !== undefined) {
        runSystemPrompt = beforeRunResult.systemPrompt;
      }
      if (beforeRunResult?.messages?.length) {
        promptMessages = [...beforeRunResult.messages, userMessage];
      }
      
      const existingMessages = this.options.loop.snapshot().messages;

      // 修改 system prompt 和 messages。
      const beforeContextResult = await this.options.lifecycleRunner?.beforeContext({
        systemPrompt: runSystemPrompt,
        messages: [...existingMessages, ...promptMessages],
      });
      if (beforeContextResult?.systemPrompt !== undefined) {
        runSystemPrompt = beforeContextResult.systemPrompt;
      }
      if (beforeContextResult?.messages !== undefined) {
        promptMessages = projectPromptMessages(existingMessages, beforeContextResult.messages);
      }

      await this.options.loop.prompt(promptMessages, { systemPrompt: runSystemPrompt });
      await this.options.loop.waitForIdle();
      this.options.afterTurn?.();
      const outcome = this.options.readExecutionOutcome();
      await this.options.lifecycleRunner?.afterRun({
        status: outcome.status === "succeeded" ? "succeeded" : "failed",
      });
      return outcome;
    }
    if (effectiveCommand.type === "steer") {
      // steer 是运行中控制命令，不等待 idle。
      this.options.loop.steer(createUserMessage(effectiveCommand.text));
      this.options.afterTurn?.();
      await this.options.lifecycleRunner?.afterRun({ status: "succeeded" });
      return { status: "succeeded" };
    }
    if (effectiveCommand.type === "follow-up") {
      // follow-up 追加后续用户意图，底层 loop 决定实际执行时机。
      this.options.loop.followUp(createUserMessage(effectiveCommand.text));
      this.options.afterTurn?.();
      await this.options.lifecycleRunner?.afterRun({ status: "succeeded" });
      return { status: "succeeded" };
    }
    // abort 不一定立刻让底层 agent 停止；这里只表示中止请求已发出。
    this.options.loop.abort();
    await this.options.lifecycleRunner?.afterRun({ status: "aborted" });
    return { status: "succeeded" };
  }
}

function projectPromptMessages(
  existingMessages: readonly AgentMessage[],
  nextContextMessages: readonly AgentMessage[],
): AgentMessage[] {
  if (nextContextMessages.length < existingMessages.length) {
    throw new Error("beforeContext cannot remove existing conversation messages in the current TurnRunner wiring.");
  }

  for (let index = 0; index < existingMessages.length; index++) {
    if (nextContextMessages[index] !== existingMessages[index]) {
      throw new Error("beforeContext must preserve the existing conversation prefix in the current TurnRunner wiring.");
    }
  }

  return nextContextMessages.slice(existingMessages.length);
}
