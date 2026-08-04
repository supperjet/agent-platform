import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import {
  AgentRuntime,
  type AgentConversationState,
  type AgentExecutionOutcome,
  type AgentRuntimeContextSnapshot,
  type AgentRuntimeCommand,
  type AgentRuntimeEventListener,
  type AgentRuntimeMessageScope,
} from "../contracts.js";
import {
  createConversationCompactionPlanWithSummarizer,
  type ConversationSummarizer,
} from "../conversation/conversation-compactor.js";
import type { ConversationRuntimeState } from "../conversation/conversation-store.js";
import type { LifecycleRunner } from "../lifecycle/lifecycle-runner.js";
import { InputProcessor } from "../prompt/input-processor.js";
import type { ProcessedInput } from "../prompt/input-processor.js";
import type { PromptTemplateRegistry } from "../prompt/prompt-template.js";
import type { SkillRegistry } from "../skills/skill-loader.js";
import type { ToolRuntimeEvent } from "../tools/tool-runtime.js";
import type { AgentLoop, AgentLoopSnapshot } from "./agent-loop.js";
import { ContextAssembler, type TurnContext } from "../context/context-assembler.js";
import { ContextBudget } from "../context/context-budget.js";
import {
  createDefaultRuntimePolicies,
  resolveCompactionPolicyDecision,
  type RuntimePolicies,
} from "../policies/runtime-policies.js";
import { EventHub } from "./event-hub.js";
import { createUserMessage } from "./messages.js";
import { StateExporter } from "./state-exporter.js";
import { TurnRunner } from "./turn-runner.js";

const DEFAULT_MAX_PENDING_LOOP_EVENTS = 1000;
const DEFAULT_MAX_QUEUED_TURNS = 100;

export type AgentRuntimeSessionOptions = {
  /**
   * 底层 AgentLoop 同步推送事件，但 `afterMessage` lifecycle hook 允许异步执行。
   * 这个上限保护 pending loop event FIFO，避免 hook 很慢或卡住时无限占用内存。
   */
  maxPendingLoopEvents?: number;
  /**
   * 等待 active prompt turn 之后执行的 prompt queue 上限。
   *
   * 只排队真正的 prompt turn。被 InputProcessor 标记为 handled 的控制/查看类
   * 输入会立即返回，不进入这个队列；running 状态下的 steer/follow-up 也会转发
   * 到当前 active turn，而不是变成 queued prompt。
   */
  maxQueuedTurns?: number;
  /** 上下文预算估算器；通常由 factory 根据当前模型上下文窗口创建。 */
  contextBudget?: ContextBudget;
  /** 运行时策略；默认保持自动压缩关闭。 */
  policies?: RuntimePolicies;
  /** 会话压缩摘要器；未提供时使用内置纯文本 fallback。失败会让本次 compaction 停止写入。 */
  conversationSummarizer?: ConversationSummarizer;
  /** 可选 prompt template registry；用于在输入阶段渲染 `/template <name> key=value`。 */
  promptTemplateRegistry?: PromptTemplateRegistry;
  /** 可选 skill registry；用于在输入阶段激活 `/skill use <name> ...`。 */
  skillRegistry?: SkillRegistry;
};

/**
 * session-level 执行状态。
 *
 * 这里描述的是 AgentRuntimeSession 对外部输入的接纳状态，不完全等同于底层
 * AgentLoop 的 streaming 状态。比如 fake loop 可能不设置 isStreaming，但 session
 * 仍然知道自己正在等待当前 prompt turn 收尾。
 */
type ExecutionState = "idle" | "running" | "aborting" | "failed";

/**
 * FIFO prompt queue 的一个等待项。
 *
 * input 已经通过 InputProcessor，因此这里不会再运行 onInput hook。resolve/reject
 * 对应外部 `execute()` 调用的 Promise。
 */
type QueuedPromptTurn = {
  readonly input: Extract<ProcessedInput, { status: "ready" }>;
  resolve(outcome: AgentExecutionOutcome): void;
  reject(error: unknown): void;
};

/**
 * lifecycle 事件处理阶段的错误包装。
 *
 * 这类错误不是模型 provider 失败，也不是工具执行失败，而是 RuntimeSession 在
 * 消费 loop events、执行 afterMessage 或维护事件队列时发生的问题。包装后调用方
 * 可以根据 stage 做诊断。
 */
export class LifecycleEventProcessingError extends Error {
  readonly stage: "afterMessage" | "loopEventQueue";

  constructor(
    stage: "afterMessage" | "loopEventQueue",
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = "LifecycleEventProcessingError";
    this.stage = stage;
  }
}

/**
 * 单个 Agent 会话的运行时对象。
 *
 * AgentRuntimeSession 是 core 对外的 Runtime 实例：
 * - 对下持有 AgentLoop，驱动底层 agent 执行。
 * - 对内通过 EventHub 维护公共事件流和执行 outcome。
 * - 对内通过 StateExporter 把底层消息快照同步成可恢复会话状态。
 * - 对内维护 session-level execution state 和 FIFO prompt queue。
 * - 对内记录每轮 ContextAssembler 输出，供 `/context` 等调试入口查看。
 * - 对外实现 AgentRuntime 的 execute/snapshot/exportState/subscribe。
 *
 * 它和 TurnRunner 的边界：
 * - AgentRuntimeSession 决定输入是否 handled、是否排队、是否转发、是否拒绝。
 * - TurnRunner 只负责执行一个已经接受的 command/ProcessedInput。
 *
 * 这让阶段 C 的队列和状态机不会散落到 prompt/context/loop 执行细节里。
 */
export class AgentRuntimeSession extends AgentRuntime {
  /** 公共事件转换与订阅中心，也保存最近一次模型 run outcome。 */
  private readonly eventHub: EventHub;
  /** 把 loop snapshot 投影成可恢复 conversation entry graph。 */
  private readonly stateExporter: StateExporter;
  /** 执行一个已接受 command 的单轮编排器。 */
  private readonly turnRunner: TurnRunner;
  /** session 级输入处理器；execute 会先跑它，再决定是否入队。 */
  private readonly inputProcessor: InputProcessor;
  /** afterMessage 替换过的 message，以 snapshot index 为 key。 */
  private readonly messageOverrides = new Map<number, AgentMessage>();
  /** promptMessages 中每个 message 对应的 persistence scope。 */
  private readonly messageScopes = new WeakMap<object, AgentRuntimeMessageScope>();
  /** 等待异步 lifecycle/event processing 的底层 loop event FIFO。 */
  private readonly pendingLoopEvents: AgentEvent[] = [];
  /** 等待当前 active prompt turn 结束后启动的 FIFO prompt queue。 */
  private readonly queuedPromptTurns: QueuedPromptTurn[] = [];
  private readonly maxPendingLoopEvents: number;
  private readonly maxQueuedTurns: number;
  /** 最近一次 ContextAssembler 输出，供 inspectContext 暴露调试视图。 */
  private lastContext: TurnContext | undefined;
  /** session-level 状态机，用于解释并发 execute 的语义。 */
  private executionState: ExecutionState = "idle";
  /** 当前 active prompt turn 是否收到了 abort request。 */
  private activePromptAbortRequested = false;
  /** 防止多个 drainLoopEvents 并发消费同一个 pendingLoopEvents FIFO。 */
  private isDrainingLoopEvents = false;
  /** 当前或最近一次 loop event drain promise，flushLoopEvents 会等待它。 */
  private drainLoopEventsPromise: Promise<void> = Promise.resolve();
  /** drain 过程中捕获的 lifecycle/event 错误，在 flushLoopEvents 时抛出。 */
  private eventProcessingError: unknown;
  /** EventHub message id 的顺序游标，同时用于 messageOverrides 对齐 snapshot index。 */
  private nextMessageIndex: number;
  private readonly contextBudget: ContextBudget;
  private readonly policies: RuntimePolicies;
  private readonly conversationSummarizer: ConversationSummarizer | undefined;
  private readonly systemPrompt: string;

  constructor(
    private readonly sessionId: string,
    private readonly loop: AgentLoop,
    conversation: ConversationRuntimeState,
    initialMessageSequence = 0,
    preferToolRuntimeEvents = false,
    private readonly lifecycleRunner?: LifecycleRunner,
    systemPrompt?: string,
    options: AgentRuntimeSessionOptions = {},
  ) {
    super();
    this.maxPendingLoopEvents =
      options.maxPendingLoopEvents ?? DEFAULT_MAX_PENDING_LOOP_EVENTS;
    this.maxQueuedTurns = options.maxQueuedTurns ?? DEFAULT_MAX_QUEUED_TURNS;
    this.contextBudget = options.contextBudget ?? new ContextBudget();
    this.policies = options.policies ?? createDefaultRuntimePolicies();
    this.conversationSummarizer = options.conversationSummarizer;
    this.systemPrompt = systemPrompt ?? "";
    // 创建事件中心。EventHub 是底层 AgentEvent -> 公共 AgentRuntimeEvent 的唯一出口。
    this.eventHub = new EventHub({
      sessionId,
      initialMessageSequence,
      preferToolRuntimeEvents,
    });

    // StateExporter 持有 conversation runtime state，并在 afterTurn 中按最新
    // lifecycle snapshot 更新 entry graph。
    this.stateExporter = new StateExporter({ sessionId, conversation });
    this.nextMessageIndex = initialMessageSequence;
    // InputProcessor 在 session 外层运行一次，原因是 handled input 必须在 queue
    // 之前短路；同一个实例也传给 TurnRunner，保证直接调用 runner 时行为一致。
    this.inputProcessor = new InputProcessor({
      ...(this.lifecycleRunner ? { lifecycleRunner: this.lifecycleRunner } : {}),
      ...(options.promptTemplateRegistry
        ? { promptTemplateRegistry: options.promptTemplateRegistry }
        : {}),
      ...(options.skillRegistry
        ? { skillRegistry: options.skillRegistry }
        : {}),
    });

    // 创建回合运行器。这里把 RuntimeSession 的收尾钩子注入给 TurnRunner：
    // - onContextAssembled：保存 `/context` 调试快照，并记录 prompt message scope。
    // - afterLoopIdle：在 state sync 前 flush events，并清理 transient prompt context。
    // - afterTurn：把清理后的 loop snapshot 同步到 StateExporter。
    this.turnRunner = new TurnRunner({
      loop: this.loop,
      inputProcessor: this.inputProcessor,
      contextAssembler: new ContextAssembler({
        ...(this.lifecycleRunner ? { lifecycleRunner: this.lifecycleRunner } : {}),
        contextBudget: this.contextBudget,
      }),
      readExecutionOutcome: () => this.eventHub.readExecutionOutcome(),
      resolvePromptOutcome: (outcome) => this.resolvePromptOutcome(outcome),
      onContextAssembled: (context) => {
        this.lastContext = context;
        this.rememberPromptMessageScopes(context);
      },
      afterLoopIdle: async (context) => {
        await this.flushLoopEvents();
        if (this.activePromptAbortRequested) {
          this.discardAbortedTurnOutputs(context);
        } else {
          this.discardTransientContextMessages(context);
        }
      },
      beforePromptStateSync: (context, outcome) => {
        if (outcome.status === "failed" || outcome.status === "commit_failed") {
          this.discardFailedTurnOutputs(context);
        }
      },
      afterTurn: async () => {
        await this.flushLoopEvents();
        this.stateExporter.syncFromSnapshot(this.readLifecycleSnapshot());
      },
      ...(this.lifecycleRunner ? { lifecycleRunner: this.lifecycleRunner } : {}),
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    });

    // 订阅底层 loop 事件。事件先进入 RuntimeSession 的 FIFO，因为 afterMessage
    // 可以异步改写 message；只有处理完成后才会发布公共事件。
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
    if (command.type === "compact") {
      return this.runManualCompaction(command);
    }
    // onInput/基础 slash metadata 解析先于排队执行。这样 `/state`、`/context`、
    // `/reload` 等未来 handled input 可以立即返回，不会排在长时间 prompt 后面。
    const processedInput = await this.inputProcessor.process({ command });
    if (processedInput.status === "handled") {
      return { status: "succeeded" };
    }
    if (processedInput.status === "rejected") {
      return processedInput.outcome;
    }
    return this.scheduleProcessedInput(processedInput);
  }

  /** 读取面向调用方的轻量 runtime 快照。 */
  snapshot() {
    const snapshot = this.readLifecycleSnapshot();
    return {
      messageCount: snapshot.messages.length,
      transcriptRoles: snapshot.messages.map((message) => message.role),
      isRunning:
        snapshot.isStreaming ||
        this.executionState === "running" ||
        this.executionState === "aborting",
      modelId: snapshot.modelId,
    };
  }

  /** 读取最近一次 prompt turn 的上下文装配结果，供 playground/debug 使用。 */
  inspectContext(): AgentRuntimeContextSnapshot | undefined {
    if (!this.lastContext) return undefined;
    // lastContext.messages = conversation prefix + promptMessages。prompt scope 只适用于
    // promptMessages，所以需要减去 conversationMessageCount。
    const persistentIndexes = new Set(this.lastContext.persistentPromptMessageIndexes);
    const transientIndexes = new Set(this.lastContext.transientPromptMessageIndexes);
    const messages = this.lastContext.messages.map((message, index) => {
      const promptIndex = index - this.lastContext!.conversationMessageCount;
      const scope: AgentRuntimeContextSnapshot["messages"][number]["scope"] =
        index < this.lastContext!.conversationMessageCount
          ? "conversation"
          : persistentIndexes.has(promptIndex)
            ? "persistent"
            : transientIndexes.has(promptIndex)
              ? "transient"
              : "unknown";
      return {
        scope,
        role: message.role,
        text: readMessageText(message),
      };
    });
    return {
      systemPrompt: this.lastContext.systemPrompt,
      messages,
      ...(this.lastContext.metadata.hooks
        ? { metadata: this.lastContext.metadata.hooks }
        : {}),
      diagnostics: this.lastContext.metadata.diagnostics,
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

  private scheduleProcessedInput(
    input: Extract<ProcessedInput, { status: "ready" }>,
  ): Promise<AgentExecutionOutcome> {
    // prompt 是唯一可以进入 FIFO queue 的完整 agent turn。
    if (input.command.type === "prompt") {
      if (this.executionState === "idle" || this.executionState === "failed") {
        return this.runPromptTurn(input);
      }
      return this.enqueuePromptTurn(input);
    }

    if (input.command.type === "steer") {
      // steer 只对 active turn 有意义。idle 下拒绝，避免把 control input 悄悄写入
      // conversation 或变成新的 prompt turn。
      if (this.executionState !== "running") {
        return Promise.resolve(rejectRuntimeInput(
          "INPUT_REJECTED",
          "Cannot steer when no prompt turn is running.",
        ));
      }
      return this.turnRunner.runProcessed(input);
    }

    if (input.command.type === "follow-up") {
      // follow-up 和 steer 一样是 active-turn control input。v1 不把 idle follow-up
      // 降级成 prompt，避免调用方误以为它已经接到了某个运行中的 turn。
      if (this.executionState !== "running") {
        return Promise.resolve(rejectRuntimeInput(
          "INPUT_REJECTED",
          "Cannot follow up when no prompt turn is running.",
        ));
      }
      return this.turnRunner.runProcessed(input);
    }

    // abort idle 是 no-op success：没有 active turn 可中止，也不创建 run。
    if (this.executionState !== "running") {
      return Promise.resolve({ status: "succeeded" });
    }
    // running abort 进入 aborting，并把请求转发给底层 loop。active prompt 的最终
    // outcome 会在 prompt turn 收尾时通过 resolvePromptOutcome 归因为 aborted。
    this.executionState = "aborting";
    this.activePromptAbortRequested = true;
    this.loop.abort();
    return Promise.resolve({ status: "succeeded" });
  }

  private enqueuePromptTurn(
    input: Extract<ProcessedInput, { status: "ready" }>,
  ): Promise<AgentExecutionOutcome> {
    // 队列上限保护的是 prompt turn，不影响 handled/control input。
    if (this.queuedPromptTurns.length >= this.maxQueuedTurns) {
      return Promise.resolve(rejectRuntimeInput(
        "TURN_QUEUE_FULL",
        `Turn queue exceeded ${this.maxQueuedTurns} queued prompt turns.`,
      ));
    }
    return new Promise<AgentExecutionOutcome>((resolve, reject) => {
      this.queuedPromptTurns.push({ input, resolve, reject });
    });
  }

  private async runPromptTurn(
    input: Extract<ProcessedInput, { status: "ready" }>,
  ): Promise<AgentExecutionOutcome> {
    this.executionState = "running";
    this.activePromptAbortRequested = false;
    let turnRunnerStarted = false;
    try {
      await this.runAutomaticCompaction(input);
      turnRunnerStarted = true;
      // 一个 prompt turn 的完整收尾顺序在 TurnRunner 回调里完成：
      // waitForIdle -> flush events -> cleanup transient context -> state sync -> afterRun。
      const outcome = await this.turnRunner.runProcessed(input);
      this.executionState = outcome.status === "failed" || outcome.status === "commit_failed" ? "failed" : "idle";
      return outcome;
    } catch (error) {
      this.executionState = "failed";
      if (!turnRunnerStarted) {
        await this.lifecycleRunner?.afterRun({ status: "failed" });
      }
      throw error;
    } finally {
      this.startNextQueuedPrompt();
    }
  }

  private resolvePromptOutcome(outcome: AgentExecutionOutcome): AgentExecutionOutcome {
    if (!this.activePromptAbortRequested) return outcome;
    if (outcome.status === "commit_failed") return outcome;
    if (outcome.status === "failed" && !isAbortFailureOutcome(outcome)) return outcome;
    return { status: "aborted" };
  }

  private startNextQueuedPrompt() {
    // 当前 turn 尚未完全结束，或 aborting 尚未收口时，不启动下一轮。
    if (this.executionState === "running" || this.executionState === "aborting") return;
    const next = this.queuedPromptTurns.shift();
    if (!next) return;
    // 后台启动下一轮，并把它的结果接回原 execute() promise。
    this.runPromptTurn(next.input).then(next.resolve, next.reject);
  }

  private async runManualCompaction(
    command: Extract<AgentRuntimeCommand, { type: "compact" }>,
  ): Promise<AgentExecutionOutcome> {
    if (this.executionState !== "idle" && this.executionState !== "failed") {
      return rejectRuntimeInput(
        "INPUT_REJECTED",
        "Cannot compact while a prompt turn is running.",
      );
    }

    try {
      await this.flushLoopEvents();
      this.stateExporter.syncFromSnapshot(this.readLifecycleSnapshot());
      const hookResult = await this.lifecycleRunner?.beforeCompaction({
        reason: command.reason ?? "manual",
        willRetry: false,
        metadata: {
          keepLastMessages: command.keepLastMessages,
        },
      });
      if (hookResult?.cancel) {
        await this.lifecycleRunner?.afterRun({ status: "succeeded" });
        return { status: "succeeded" };
      }

      const currentState = this.stateExporter.exportState(this.readLifecycleSnapshot());
      // manual compact 与 automatic compact 共用同一个 plan + summarizer 流程。
      // summarizer 只负责生成 summary；压缩范围已经由 keepLastMessages / selection 决定。
      const plan = await createConversationCompactionPlanWithSummarizer({
        createdBy: "runtime",
        entries: currentState.payload.entries,
        leafId: currentState.payload.leafId,
        reason: command.reason ?? "manual",
        ...(hookResult?.instructions ? { instructions: hookResult.instructions } : {}),
        ...(command.keepLastMessages === undefined
          ? {}
          : { keepLastMessages: command.keepLastMessages }),
        ...(this.conversationSummarizer
          ? { summarizer: this.conversationSummarizer }
          : {}),
      });
      if (!plan) {
        await this.lifecycleRunner?.afterRun({ status: "succeeded" });
        return { status: "succeeded" };
      }

      this.stateExporter.appendCompaction(plan);
      this.loop.replaceMessages(this.stateExporter.projectMessages());
      this.messageOverrides.clear();
      this.nextMessageIndex = this.loop.snapshot().messages.length;
      await this.lifecycleRunner?.afterRun({ status: "succeeded" });
      return { status: "succeeded" };
    } catch (error) {
      await this.lifecycleRunner?.afterRun({ status: "failed" });
      return {
        status: "failed",
        errorCode: "COMPACTION_FAILED",
        message: readErrorMessage(error),
      };
    }
  }

  private async runAutomaticCompaction(
    input: Extract<ProcessedInput, { status: "ready" }>,
  ): Promise<void> {
    if (input.command.type !== "prompt") return;
    const policy = this.policies.compaction;
    if (policy === "disabled") return;

    await this.flushLoopEvents();
    this.stateExporter.syncFromSnapshot(this.readLifecycleSnapshot());
    const projectedMessages = this.stateExporter.projectMessages();
    const estimate = this.contextBudget.estimate(
      [...projectedMessages, createUserMessage(input.command.text)],
      { systemPrompt: this.systemPrompt },
    );
    const decision = resolveCompactionPolicyDecision(policy, estimate);
    if (!decision) return;

    const hookResult = await this.lifecycleRunner?.beforeCompaction({
      reason: decision.reason,
      willRetry: false,
      metadata: decision.metadata,
    });
    if (hookResult?.cancel) return;

    const currentState = this.stateExporter.exportState(this.readLifecycleSnapshot());
    // 自动压缩先由 policy 解析出 selection，再交给 compactor 固定 source/preserved
    // 边界；LLM summarizer 失败时不会 append compaction entry。
    const plan = await createConversationCompactionPlanWithSummarizer({
      entries: currentState.payload.entries,
      leafId: currentState.payload.leafId,
      reason: decision.reason,
      ...(hookResult?.instructions ? { instructions: hookResult.instructions } : {}),
      selection: {
        ...decision.selection,
        contextBudget: this.contextBudget,
        nextMessages: [createUserMessage(input.command.text)],
        ...(this.systemPrompt ? { systemPrompt: this.systemPrompt } : {}),
      },
      createdBy: "runtime",
      ...(this.conversationSummarizer
        ? { summarizer: this.conversationSummarizer }
        : {}),
    });
    if (!plan) return;

    this.stateExporter.appendCompaction(plan);
    this.loop.replaceMessages(this.stateExporter.projectMessages());
    this.messageOverrides.clear();
    this.nextMessageIndex = this.loop.snapshot().messages.length;
  }

  /**
   * 底层 loop 的事件是同步推送的，但 afterMessage hook 可能是异步的。
   * 这里显式维护一个 FIFO 队列，让事件按收到顺序逐个处理。
   */
  private enqueueLoopEvent(event: AgentEvent) {
    // 队列满时不再接受新事件，但错误会延迟到 flushLoopEvents 抛出。这样同步的
    // loop.subscribe 回调不会直接抛穿底层 agent。
    if (this.pendingLoopEvents.length >= this.maxPendingLoopEvents) {
      this.eventProcessingError ??= new LifecycleEventProcessingError(
        "loopEventQueue",
        `Agent loop event queue exceeded ${this.maxPendingLoopEvents} pending events.`,
      );
      return;
    }
    this.pendingLoopEvents.push(event);
    if (!this.isDrainingLoopEvents) {
      this.drainLoopEventsPromise = this.drainLoopEvents();
    }
  }

  private async drainLoopEvents() {
    // 串行消费，保持底层事件顺序。即使多个 event 很快连续进入，也只会有一个 drain
    // 在推进。
    this.isDrainingLoopEvents = true;
    try {
      while (this.pendingLoopEvents.length > 0) {
        const event = this.pendingLoopEvents.shift();
        if (!event) continue;
        try {
          await this.processLoopEvent(event);
        } catch (error) {
          this.eventProcessingError ??= normalizeLifecycleEventProcessingError(error);
        }
      }
    } finally {
      this.isDrainingLoopEvents = false;
    }
  }

  private async processLoopEvent(event: AgentEvent) {
    if (
      event.type === "message_end" &&
      this.activePromptAbortRequested &&
      isAssistantAbortMessage(event.message)
    ) {
      // 底层 agent 可能把用户主动 abort 表达成 assistant error message
      // （例如 "Request was aborted"）。对 agent-core 来说这不是 run_failed，
      // 而是主动取消；跳过该 message_end，等待 agent_end 统一发布 run_aborted。
      return;
    }

    if (
      event.type === "agent_end" &&
      this.activePromptAbortRequested &&
      this.eventHub.readExecutionOutcome().status !== "failed"
    ) {
      this.eventHub.publishRunAborted();
      return;
    }

    // message scope 来自本轮 ContextAssembler 记录的 promptMessages 身份。
    // 不在 promptMessages 中的历史/assistant/tool message 默认 persistent。
    const messageScope = this.readEventMessageScope(event);
    if (event.type !== "message_end") {
      this.eventHub.publishAgentEvent(
        event,
        messageScope ? { messageScope } : {},
      );
      return;
    }

    const messageIndex = this.nextMessageIndex;
    this.nextMessageIndex += 1;
    let hookResult;
    try {
      // afterMessage 是唯一可以改写 message 的 lifecycle hook。它只在 message_end
      // 执行，确保 message_started 先按原始消息发布，message_finished 可以反映替换后内容。
      hookResult = await this.lifecycleRunner?.afterMessage({
        message: event.message,
      });
    } catch (error) {
      throw new LifecycleEventProcessingError(
        "afterMessage",
        `afterMessage lifecycle hook failed: ${readErrorMessage(error)}`,
        { cause: error },
      );
    }
    const message = hookResult?.message ?? event.message;
    if (message !== event.message) {
      // 替换只能改内容，不能改 role；否则 conversation graph 和公共事件语义会失真。
      assertSameMessageRole(event.message, message);
      this.messageOverrides.set(messageIndex, message);
    }

    this.eventHub.publishAgentEvent(
      {
        ...event,
        message,
      } as AgentEvent,
      messageScope ? { messageScope } : {},
    );
  }

  private async flushLoopEvents() {
    // prompt turn 收尾、afterTurn、外部 export 前都通过这个方法确保 pending events
    // 已经完成 lifecycle 处理。
    await this.drainLoopEventsPromise;
    if (this.eventProcessingError) {
      const error = this.eventProcessingError;
      this.eventProcessingError = undefined;
      throw error;
    }
  }

  /** 丢弃 transient context messages。 */
  private discardTransientContextMessages(context: TurnContext) {
    if (context.transientPromptMessageIndexes.length === 0) return;
    // transientPromptMessageIndexes 是 promptMessages 内的索引；底层 snapshot 里还包含
    // conversation prefix，因此需要加 conversationMessageCount 才能定位真实 snapshot index。
    const transientSnapshotIndexes = new Set(
      context.transientPromptMessageIndexes.map(
        (index) => context.conversationMessageCount + index,
      ),
    );
    const snapshot = this.readLifecycleSnapshot();
    this.loop.replaceMessages(
      snapshot.messages.filter((_, index) => !transientSnapshotIndexes.has(index)),
    );
    // 清理后 snapshot index 会变化，messageOverrides 和 nextMessageIndex 必须重新对齐。
    this.messageOverrides.clear();
    this.nextMessageIndex = this.loop.snapshot().messages.length;
  }

  /** 主动 abort 后，只保留历史消息和本轮 persistent prompt 输入。 */
  private discardAbortedTurnOutputs(context: TurnContext) {
    const persistentIndexes = new Set(context.persistentPromptMessageIndexes);
    const snapshot = this.readLifecycleSnapshot();
    const retainedMessages = [
      ...snapshot.messages.slice(0, context.conversationMessageCount),
      ...context.promptMessages.filter((_, index) => persistentIndexes.has(index)),
    ];
    this.loop.replaceMessages(retainedMessages);
    // 截断 snapshot 后，所有基于旧 snapshot index 的 afterMessage override 都失效。
    this.messageOverrides.clear();
    this.nextMessageIndex = this.loop.snapshot().messages.length;
  }

  /** prompt turn 失败后，默认保留失败前已经持久化的 conversation prefix。 */
  private discardFailedTurnOutputs(context: TurnContext) {
    const snapshot = this.readLifecycleSnapshot();
    const retainedMessages = snapshot.messages.slice(0, context.conversationMessageCount);
    this.loop.replaceMessages(retainedMessages);
    // 截断 snapshot 后，所有基于失败 turn snapshot index 的 afterMessage override 都失效。
    this.messageOverrides.clear();
    this.nextMessageIndex = this.loop.snapshot().messages.length;
  }

  private rememberPromptMessageScopes(context: TurnContext) {
    // WeakMap 使用 message 对象身份记录 scope，避免把 scope 写进 AgentMessage 本身。
    const persistentIndexes = new Set(context.persistentPromptMessageIndexes);
    const transientIndexes = new Set(context.transientPromptMessageIndexes);
    context.promptMessages.forEach((message, index) => {
      const scope: AgentRuntimeMessageScope = persistentIndexes.has(index)
        ? "persistent"
        : transientIndexes.has(index)
          ? "transient"
          : "unknown";
      this.messageScopes.set(message as object, scope);
    });
  }

  private readEventMessageScope(event: AgentEvent): AgentRuntimeMessageScope | undefined {
    if (
      event.type !== "message_start" &&
      event.type !== "message_end"
    ) {
      return undefined;
    }
    return this.messageScopes.get(event.message as object) ?? "persistent";
  }

  private readLifecycleSnapshot(): AgentLoopSnapshot {
    // StateExporter/exportState 读到的是 afterMessage 替换后的逻辑 snapshot，而不是
    // 底层 loop 原始 snapshot。
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

function normalizeLifecycleEventProcessingError(
  error: unknown,
): LifecycleEventProcessingError {
  if (error instanceof LifecycleEventProcessingError) return error;
  return new LifecycleEventProcessingError(
    "afterMessage",
    `afterMessage lifecycle processing failed: ${readErrorMessage(error)}`,
    { cause: error },
  );
}

function isAbortFailureOutcome(outcome: AgentExecutionOutcome): boolean {
  return outcome.status === "failed" && isAbortMessage(outcome.message);
}

function isAssistantAbortMessage(message: AgentMessage): boolean {
  return message.role === "assistant" &&
    "errorMessage" in message &&
    typeof message.errorMessage === "string" &&
    isAbortMessage(message.errorMessage);
}

function isAbortMessage(message: string): boolean {
  return message.toLowerCase().includes("abort");
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function rejectRuntimeInput(
  errorCode: string,
  message: string,
): AgentExecutionOutcome {
  return {
    status: "failed",
    errorCode,
    message,
  };
}

function readMessageText(message: AgentMessage): string {
  if (!("content" in message) || !Array.isArray(message.content)) return "";
  return message.content.flatMap((block: unknown) => {
    if (!block || typeof block !== "object" || !("type" in block) || block.type !== "text") return [];
    return "text" in block && typeof block.text === "string" ? [block.text] : [];
  }).join("\n");
}
