import {
  type AgentExecutionOutcome,
  type AgentRuntimeCommand,
} from "../contracts.js";
import { ContextAssembler } from "../context/context-assembler.js";
import type { LifecycleRunner } from "../lifecycle/lifecycle-runner.js";
import { InputProcessor } from "../prompt/input-processor.js";
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
  afterTurn?: () => void | Promise<void>;
  /** 内部生命周期执行器；第一版用于输入、run/context 打点和运行结束通知。 */
  lifecycleRunner?: LifecycleRunner;
  /** 输入处理器；默认使用 lifecycleRunner 创建第一版 InputProcessor。 */
  inputProcessor?: InputProcessor;
  /** 上下文装配器；默认使用 lifecycleRunner 创建第一版 ContextAssembler。 */
  contextAssembler?: ContextAssembler;
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
  private readonly inputProcessor: InputProcessor;
  private readonly contextAssembler: ContextAssembler;

  constructor(private readonly options: TurnRunnerOptions) {
    this.inputProcessor =
      options.inputProcessor ??
      new InputProcessor({
        ...(options.lifecycleRunner
          ? { lifecycleRunner: options.lifecycleRunner }
          : {}),
      });
    this.contextAssembler =
      options.contextAssembler ??
      new ContextAssembler({
        ...(options.lifecycleRunner
          ? { lifecycleRunner: options.lifecycleRunner }
          : {}),
      });
  }

  async run(command: AgentRuntimeCommand): Promise<AgentExecutionOutcome> {
    const processedInput = await this.inputProcessor.process({ command });
    // 如果输入被 InputProcessor 判定为已处理，直接返回成功。（一些不需要进入大模型的命令）（这里处理了一些简单的命令，比如查询、获取等）
    if (processedInput.status === "handled") {
      await this.options.lifecycleRunner?.afterRun({ status: "succeeded" });
      return { status: "succeeded" };
    }
    const effectiveCommand = processedInput.command;

    // 如果输入是 prompt 命令，需要等待底层执行结束，再同步状态和读取 outcome。
    if (effectiveCommand.type === "prompt") {
      // 组装上下文，包括 system prompt 和 messages。
      const turnContext = await this.contextAssembler.assemble({
        command: effectiveCommand,
        baseSystemPrompt: this.options.systemPrompt ?? "",
        conversationMessages: this.options.loop.snapshot().messages,
      });
      // 发送 prompt 命令，等待底层执行结束，再同步状态和读取 outcome。
      await this.options.loop.prompt(turnContext.promptMessages, {
        systemPrompt: turnContext.systemPrompt,
      });
      // 等待底层执行结束，再同步状态和读取 outcome。
      await this.options.loop.waitForIdle();
      await this.options.afterTurn?.();
      const outcome = this.options.readExecutionOutcome();
      await this.options.lifecycleRunner?.afterRun({
        status: outcome.status === "succeeded" ? "succeeded" : "failed",
        ...(turnContext.metadata.hooks ? { metadata: turnContext.metadata.hooks } : {}),
      });
      return outcome;
    }
    if (effectiveCommand.type === "steer") {
      // steer 是运行中控制命令，不等待 idle。
      this.options.loop.steer(createUserMessage(effectiveCommand.text));
      await this.options.afterTurn?.();
      await this.options.lifecycleRunner?.afterRun({ status: "succeeded" });
      return { status: "succeeded" };
    }
    if (effectiveCommand.type === "follow-up") {
      // follow-up 追加后续用户意图，底层 loop 决定实际执行时机。
      this.options.loop.followUp(createUserMessage(effectiveCommand.text));
      await this.options.afterTurn?.();
      await this.options.lifecycleRunner?.afterRun({ status: "succeeded" });
      return { status: "succeeded" };
    }
    // abort 不一定立刻让底层 agent 停止；这里只表示中止请求已发出。
    this.options.loop.abort();
    await this.options.lifecycleRunner?.afterRun({ status: "aborted" });
    return { status: "succeeded" };
  }
}
