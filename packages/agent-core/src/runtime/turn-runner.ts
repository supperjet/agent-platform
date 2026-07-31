import {
  type AgentExecutionOutcome,
  type AgentRuntimeCommand,
} from "../contracts.js";
import { ContextAssembler } from "../context/context-assembler.js";
import type { TurnContext } from "../context/context-assembler.js";
import type { LifecycleRunner } from "../lifecycle/lifecycle-runner.js";
import { InputProcessor } from "../prompt/input-processor.js";
import type { ProcessedInput } from "../prompt/input-processor.js";
import type { AgentLoop } from "./agent-loop.js";
import { createUserMessage } from "./messages.js";

/**
 * TurnRunner 运行一个命令所需的依赖。
 *
 * 这个类型刻意只描述“执行一个已接受命令”需要的东西，不包含 session-level
 * queue、并发输入、abort 状态机等职责。那些职责由 `AgentRuntimeSession`
 * 负责，避免 `TurnRunner` 同时知道“如何排队”和“如何跑一轮”。
 */
export type TurnRunnerOptions = {
  /** 底层 agent 执行循环。 */
  loop: AgentLoop;
  /** 从 EventHub 读取最近一次 prompt run 的 outcome。 */
  readExecutionOutcome: () => AgentExecutionOutcome;
  /**
   * prompt turn 收尾时最后一次修正 outcome 的入口。
   *
   * EventHub 只能根据底层 agent events 判断 succeeded/failed；session-level abort
   * request 由 AgentRuntimeSession 持有，因此 active prompt 被 abort 时需要在这里
   * 把 succeeded outcome 归因为 aborted。
   */
  resolvePromptOutcome?: (outcome: AgentExecutionOutcome) => AgentExecutionOutcome;
  /** 每次会改变消息历史的命令之后调用，通常用于同步 StateExporter。 */
  afterTurn?: () => void | Promise<void>;
  /** prompt run idle 后、状态同步前调用，通常用于 flush events 和清理 run-local context。 */
  afterLoopIdle?: (context: TurnContext) => void | Promise<void>;
  /** prompt state sync 前调用，允许 session 根据最终 outcome 清理不可持久化输出。 */
  beforePromptStateSync?: (
    context: TurnContext,
    outcome: AgentExecutionOutcome,
  ) => void | Promise<void>;
  /** 每次 prompt context 组装完成后调用，通常用于调试快照。 */
  onContextAssembled?: (context: TurnContext) => void;
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
 *
 * 它的边界是“跑一个 command”，不是“决定这个 command 什么时候可以跑”。
 * 阶段 C 引入的 FIFO prompt queue、running/idle 判定、idle 下 control command
 * reject 等语义都在 `AgentRuntimeSession` 外层处理。这样 `TurnRunner` 仍然可以
 * 被单元测试直接调用，也能被 session 传入已经处理过的 `ProcessedInput`。
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
    // 兼容直接使用 TurnRunner 的调用方：这里仍然会自己执行 InputProcessor。
    // AgentRuntimeSession 会提前执行同一个 inputProcessor，然后调用 runProcessed，
    // 以便 handled input 可以不进入 prompt queue。
    const processedInput = await this.inputProcessor.process({ command });
    return this.runProcessed(processedInput);
  }

  /**
   * 执行一个已经过 InputProcessor 归一化的输入。
   *
   * session-level controller 使用这个入口避免重复运行 onInput hook：
   *
   * ```text
   * AgentRuntimeSession.execute
   *   -> InputProcessor.process
   *   -> handled: 直接返回，不入队
   *   -> ready: 按 session 状态决定立即执行、排队、转发或拒绝
   *   -> TurnRunner.runProcessed
   * ```
   */
  async runProcessed(processedInput: ProcessedInput): Promise<AgentExecutionOutcome> {
    let afterRunNotified = false;
    let afterRunMetadata: Record<string, unknown> | undefined;
    let turnContext: TurnContext | undefined;
    let stateSyncStarted = false;

    try {
      // handled 表示输入已经被 runtime-local 逻辑或 lifecycle onInput 消费。
      // 直接调用 TurnRunner 时仍通知 afterRun；AgentRuntimeSession 会在更外层
      // 提前短路，因此不会把 handled input 当作 prompt turn 入队。
      if (processedInput.status === "handled") {
        afterRunNotified = true;
        await this.options.lifecycleRunner?.afterRun({ status: "succeeded" });
        return { status: "succeeded" };
      }
      const effectiveCommand = processedInput.command;

      // prompt 是唯一完整模型 turn：需要组装上下文、提交给底层 loop、等待 idle、
      // 再把事件和 state 收尾，最后根据 EventHub 读取 run outcome。
      if (effectiveCommand.type === "prompt") {
        // ContextAssembler 会消费 conversation snapshot、base system prompt、
        // input metadata，并运行 beforeRun/beforeContext。输出的 turnContext 同时
        // 包含实际 promptMessages 和诊断信息。
        turnContext = await this.contextAssembler.assemble({
          command: effectiveCommand,
          baseSystemPrompt: this.options.systemPrompt ?? "",
          conversationMessages: this.options.loop.snapshot().messages,
          ...(processedInput.metadata ? { metadata: processedInput.metadata } : {}),
        });
        this.options.onContextAssembled?.(turnContext);
        if (turnContext.metadata.hooks) {
          afterRunMetadata = turnContext.metadata.hooks;
        }
        // promptMessages 可能包含 lifecycle 注入的 transient context message。
        // 是否清理这些 transient message 由 afterLoopIdle 回调负责。
        await this.options.loop.prompt(turnContext.promptMessages, {
          systemPrompt: turnContext.systemPrompt,
        });
        // waitForIdle 是 prompt turn 的分界点：此时底层 loop 已经停止流式输出，
        // 但公共事件和 exported state 还没有完全收尾。
        await this.options.loop.waitForIdle();
        // 这个回调发生在 state sync 之前，供 RuntimeSession flush loop events、
        // 应用 afterMessage、发布 scoped message events，并清理 transient context。
        await this.options.afterLoopIdle?.(turnContext);
        const rawOutcome = this.options.readExecutionOutcome();
        const outcome = this.options.resolvePromptOutcome?.(rawOutcome) ?? rawOutcome;
        await this.options.beforePromptStateSync?.(turnContext, outcome);
        // afterTurn 通常负责把清理后的 loop snapshot 同步到 StateExporter。
        stateSyncStarted = true;
        await this.options.afterTurn?.();
        afterRunNotified = true;
        await this.options.lifecycleRunner?.afterRun({
          status: toAfterRunStatus(outcome),
          ...(afterRunMetadata ? { metadata: afterRunMetadata } : {}),
        });
        return outcome;
      }
      if (effectiveCommand.type === "steer") {
        // steer 是运行中控制命令，不等待 idle，也不创建完整 prompt turn。
        // 是否允许 idle 下 steer 由 AgentRuntimeSession 判定；直接使用 TurnRunner
        // 时会无条件转发给底层 loop。
        this.options.loop.steer(createUserMessage(effectiveCommand.text));
        await this.options.afterTurn?.();
        afterRunNotified = true;
        await this.options.lifecycleRunner?.afterRun({ status: "succeeded" });
        return { status: "succeeded" };
      }
      if (effectiveCommand.type === "follow-up") {
        // follow-up 表示“给当前执行追加后续意图”，底层 loop 决定何时消费。
        // 它不是 FIFO prompt queue item，因此这里不等待 idle。
        this.options.loop.followUp(createUserMessage(effectiveCommand.text));
        await this.options.afterTurn?.();
        afterRunNotified = true;
        await this.options.lifecycleRunner?.afterRun({ status: "succeeded" });
        return { status: "succeeded" };
      }
      if (effectiveCommand.type === "compact") {
        afterRunNotified = true;
        await this.options.lifecycleRunner?.afterRun({ status: "failed" });
        return {
          status: "failed",
          errorCode: "INPUT_REJECTED",
          message: "Manual compaction must be handled by AgentRuntimeSession.",
        };
      }
      // abort 不一定立刻让底层 agent 停止；这里只表示中止请求已发出。
      // 直接调用 TurnRunner 的 abort 会立即通知 afterRun(aborted)；通过
      // AgentRuntimeSession abort active prompt 时，则由 session 在 prompt 收尾时
      // 把 active prompt outcome 归因为 aborted。
      this.options.loop.abort();
      afterRunNotified = true;
      await this.options.lifecycleRunner?.afterRun({ status: "aborted" });
      return { status: "succeeded" };
    } catch (error) {
      // 任何发生在 input/context/loop/event flush/state sync 之间的异常，
      // 如果还没有发出 terminal afterRun，就统一通知 failed。这样 lifecycle
      // 调用方不会在失败路径丢失 run 结束信号。
      if (turnContext && !stateSyncStarted) {
        await this.options.beforePromptStateSync?.(turnContext, {
          status: "failed",
          errorCode: "TURN_FAILED",
          message: readErrorMessage(error),
        });
      }
      if (!afterRunNotified) {
        await this.options.lifecycleRunner?.afterRun({
          status: "failed",
          ...(afterRunMetadata ? { metadata: afterRunMetadata } : {}),
        });
      }
      throw error;
    }
  }
}

function toAfterRunStatus(
  outcome: AgentExecutionOutcome,
): "succeeded" | "failed" | "aborted" {
  if (outcome.status === "aborted") return "aborted";
  if (outcome.status === "commit_failed") return "failed";
  return outcome.status === "succeeded" ? "succeeded" : "failed";
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
