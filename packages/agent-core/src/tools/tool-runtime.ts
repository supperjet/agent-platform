import type {
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@earendil-works/pi-agent-core";
import {
  ToolPolicyDecisionType,
  type ToolApprovalHandler,
  type ToolPolicy,
  type ToolPolicyDecision,
} from "./policy/index.js";
import {
  createLifecycleRunner,
  type LifecycleRunner,
} from "../lifecycle/lifecycle-runner.js";

// ---------------------------------------------------------------------------
// 工具执行结果与上下文
// ---------------------------------------------------------------------------

/**
 * ToolRuntime 对一次工具调用的标准化状态归类。
 *
 * 这里刻意把 `blocked` 和 `failed` 区分开：
 * - `blocked` 表示运行前被 policy / approval / hook 拦截，工具本体没有执行。
 * - `failed` 表示工具本体或成功态 after hook 抛错。
 */
export type ToolRuntimeStatus = "succeeded" | "failed" | "aborted" | "blocked";

/**
 * 跟随一次工具调用传递的编排上下文。
 *
 * 它不是工具业务参数，也不进入模型参数 schema；主要给 runtime hook、
 * 生命周期事件、审计日志使用。
 */
export type ToolRuntimeContext = {
  sessionId?: string;
  definitionId?: string;
  metadata?: Record<string, unknown>;
};

/**
 * 对任意 thrown value 的轻量标准化。
 *
 * Runtime 对外不直接暴露原始 Error 对象，避免调用方依赖宿主环境中的 Error
 * 实例细节；但仍保留 name/message/stack 方便调试。
 */
export type ToolRuntimeError = {
  name?: string;
  message: string;
  stack?: string;
};

/**
 * ToolRuntime 执行一次工具调用所需的完整输入。
 *
 * `args` 是已经由 agent loop / prepareArguments 处理过的工具参数；
 * `signal` 和 `onUpdate` 会原样传给工具，但 Runtime 会在中间包一层，
 * 以便统一处理取消和流式更新事件。
 */
export type ToolRuntimeExecuteInput<TDetails = any> = {
  tool: AgentTool<any, TDetails>;
  toolCallId: string;
  args: unknown;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback<TDetails>;
  onEvent?: ToolRuntimeEventListener;
  context?: ToolRuntimeContext;
};

/**
 * ToolRuntime 返回给上层编排代码的结构化执行结果。
 *
 * 这个结果比 pi-agent-core 的 `AgentToolResult` 多了状态、错误和耗时信息，
 * 因此适合作为审计、事件桥接、测试断言和未来 approval UI 的统一边界。
 */
export type ToolRuntimeExecuteResult<TDetails = any> = {
  toolName: string;
  toolCallId: string;
  status: ToolRuntimeStatus;
  result?: AgentToolResult<TDetails>;
  error?: ToolRuntimeError;
  startedAt: Date;
  endedAt: Date;
  durationMs: number;
};

// ---------------------------------------------------------------------------
// 生命周期事件
// ---------------------------------------------------------------------------

/** ToolRuntime 生命周期事件类型。 */
export enum ToolRuntimeEventType {
  Started = "tool_started",
  PolicyChecked = "tool_policy_checked",
  ApprovalRequested = "tool_approval_requested",
  ApprovalApproved = "tool_approval_approved",
  ApprovalDenied = "tool_approval_denied",
  Updated = "tool_updated",
  Finished = "tool_finished",
}

/**
 * 工具调用开始事件。
 *
 * 事件在 before hook 之前发出，因此即使后续被 policy block，也能看到
 * “曾经尝试调用工具”这件事。
 */
export type ToolRuntimeStartedEvent = {
  type: ToolRuntimeEventType.Started;
  toolName: string;
  toolCallId: string;
  args: unknown;
  context?: ToolRuntimeContext;
  timestamp: Date;
};

/**
 * 工具策略检查事件。
 *
 * 该事件只表示 policy 已经给出决策；是否继续执行还要看决策类型和 approval
 * 结果。没有配置 policy 时不会发出该事件。
 */
export type ToolRuntimePolicyCheckedEvent = {
  type: ToolRuntimeEventType.PolicyChecked;
  toolName: string;
  toolCallId: string;
  args: unknown;
  decision: ToolPolicyDecision;
  context?: ToolRuntimeContext;
  timestamp: Date;
};

/**
 * 工具调用请求人工/宿主确认事件。
 *
 * ToolRuntime 只发出结构化请求，不直接承担 UI；真正确认由 ToolApprovalHandler
 * 或上层运行环境提供。
 */
export type ToolRuntimeApprovalRequestedEvent = {
  type: ToolRuntimeEventType.ApprovalRequested;
  toolName: string;
  toolCallId: string;
  args: unknown;
  decision: Extract<ToolPolicyDecision, { type: ToolPolicyDecisionType.RequireApproval }>;
  context?: ToolRuntimeContext;
  timestamp: Date;
};

/** approval 通过事件。 */
export type ToolRuntimeApprovalApprovedEvent = {
  type: ToolRuntimeEventType.ApprovalApproved;
  toolName: string;
  toolCallId: string;
  args: unknown;
  context?: ToolRuntimeContext;
  timestamp: Date;
};

/** approval 拒绝事件。 */
export type ToolRuntimeApprovalDeniedEvent = {
  type: ToolRuntimeEventType.ApprovalDenied;
  toolName: string;
  toolCallId: string;
  args: unknown;
  reason: string;
  context?: ToolRuntimeContext;
  timestamp: Date;
};

/**
 * 工具调用过程中的增量更新事件。
 *
 * 该事件来自工具内部调用 `onUpdate(...)`。Runtime 会先发出该事件，
 * 再把同一份 partial result 转发给原始调用方。
 */
export type ToolRuntimeUpdatedEvent<TDetails = any> = {
  type: ToolRuntimeEventType.Updated;
  toolName: string;
  toolCallId: string;
  result: AgentToolResult<TDetails>;
  context?: ToolRuntimeContext;
  timestamp: Date;
};

/**
 * 工具调用终态事件。
 *
 * 成功、失败、取消、被阻止都会走到这里；上层如果要桥接到 server/client
 * public event，优先从这个事件读取最终状态。
 */
export type ToolRuntimeFinishedEvent<TDetails = any> = {
  type: ToolRuntimeEventType.Finished;
  toolName: string;
  toolCallId: string;
  status: ToolRuntimeStatus;
  result?: AgentToolResult<TDetails>;
  error?: ToolRuntimeError;
  context?: ToolRuntimeContext;
  startedAt: Date;
  endedAt: Date;
  durationMs: number;
};

/** ToolRuntime 当前公开的所有生命周期事件联合类型。 */
export type ToolRuntimeEvent<TDetails = any> =
  | ToolRuntimeStartedEvent
  | ToolRuntimePolicyCheckedEvent
  | ToolRuntimeApprovalRequestedEvent
  | ToolRuntimeApprovalApprovedEvent
  | ToolRuntimeApprovalDeniedEvent
  | ToolRuntimeUpdatedEvent<TDetails>
  | ToolRuntimeFinishedEvent<TDetails>;

/**
 * 生命周期事件监听器。
 *
 * 监听器只做观测，不参与工具执行控制；如果监听器抛错，Runtime 会吞掉异常，
 * 防止日志/UI 侧问题污染工具调用本身。
 */
export type ToolRuntimeEventListener = (event: ToolRuntimeEvent) => void;

// ---------------------------------------------------------------------------
// Runtime 对外接口
// ---------------------------------------------------------------------------

/**
 * 创建 ToolRuntime 时可注入的扩展点。
 *
 * ToolRuntime 不再拥有自己的 before/after hook 定义；工具调用前后的控制点
 * 统一挂在 LifecycleRunner 上。这里保留工具执行网关真正负责的能力：
 * policy、approval 和对外观测事件。
 */
export type ToolRuntimeOptions = {
  lifecycleRunner?: LifecycleRunner;
  policy?: ToolPolicy;
  approvalHandler?: ToolApprovalHandler;
  // 工具生命周期事件监听器
  onEvent?: ToolRuntimeEventListener;
};

/**
 * 工具生命周期执行器。
 *
 * Registry/Catalog 负责“有什么工具、启用哪些工具”，ToolRuntime 负责“一次工具
 * 调用怎么被执行、观察、拦截和归档”。
 */
export type ToolRuntime = {
  execute<TDetails = any>(
    input: ToolRuntimeExecuteInput<TDetails>,
  ): Promise<ToolRuntimeExecuteResult<TDetails>>;
};

/**
 * 创建默认工具运行时。
 *
 * ToolRuntime 不负责注册或选择工具，只负责包住一次工具调用：
 * lifecycle.beforeToolCall -> policy/approval -> 原始 tool.execute
 * -> lifecycle.afterToolCall -> 结构化执行结果。
 */
export function createToolRuntime(
  options: ToolRuntimeOptions = {},
): ToolRuntime {
  const lifecycleRunner = options.lifecycleRunner ?? createLifecycleRunner();
  const policy = options.policy;
  const approvalHandler = options.approvalHandler;
  const defaultOnEvent = options.onEvent;

  return {
    async execute<TDetails = any>(
      input: ToolRuntimeExecuteInput<TDetails>,
    ): Promise<ToolRuntimeExecuteResult<TDetails>> {
      const onEvent = createRuntimeEventListener(defaultOnEvent, input.onEvent);
      const startedAt = new Date();
      // 开始事件在所有 hook 前发出，确保 blocked/aborted 调用也有完整轨迹。
      emitToolRuntimeEvent(onEvent, {
        type: ToolRuntimeEventType.Started,
        toolName: input.tool.name,
        toolCallId: input.toolCallId,
        args: input.args,
        ...(input.context ? { context: input.context } : {}),
        timestamp: startedAt,
      });

      try {
        // 如果调用进入 Runtime 前已经取消，就不再执行 before hook 或工具本体。
        if (input.signal?.aborted) {
          return finish(
            input,
            "aborted",
            startedAt,
            onEvent,
            undefined,
            {
              name: "AbortError",
              message: "Tool execution aborted.",
            },
          );
        }

        // 工具执行前的控制点统一交给 LifecycleRunner；这里不再维护平行 hook 链。
        const beforeResult = await lifecycleRunner.beforeToolCall(input);
        if (beforeResult.status === "blocked") {
          return finish(
            input,
            "blocked",
            startedAt,
            onEvent,
            undefined,
            {
              name: "ToolBlockedError",
              message: beforeResult.reason,
            },
          );
        }
        const lifecycleInput = beforeResult.args === input.args
          ? input
          : {
              ...input,
              args: beforeResult.args,
            };

        // policy 是正式的安全/权限/approval 语义层。它可以允许、阻止、改写参数，
        // 或要求宿主先确认。
        const policyResult = await runToolPolicy(policy, approvalHandler, lifecycleInput, onEvent);
        if (policyResult.status === "blocked") {
          return finish(
            lifecycleInput,
            "blocked",
            startedAt,
            onEvent,
            undefined,
            {
              name: "ToolPolicyBlockedError",
              message: policyResult.reason,
            },
          );
        }
        const effectiveInput = policyResult.args === lifecycleInput.args
          ? lifecycleInput
          : {
              ...lifecycleInput,
              args: policyResult.args,
            };

        // 包装 onUpdate：先发 Runtime 生命周期事件，再转发给 pi-agent-core 的原回调。
        const onUpdate = createRuntimeUpdateCallback(effectiveInput, onEvent);
        const result = await effectiveInput.tool.execute(
          effectiveInput.toolCallId,
          effectiveInput.args as never,
          effectiveInput.signal,
          onUpdate,
        );
        return finish(effectiveInput, "succeeded", startedAt, onEvent, result);
      } catch (error) {
        return finish(
          input,
          input.signal?.aborted ? "aborted" : "failed",
          startedAt,
          onEvent,
          undefined,
          normalizeToolRuntimeError(error),
        );
      }
    },
  };

  async function finish<TDetails = any>(
    input: ToolRuntimeExecuteInput<TDetails>,
    status: ToolRuntimeStatus,
    startedAt: Date,
    onEvent: ToolRuntimeEventListener | undefined,
    result?: AgentToolResult<TDetails>,
    error?: ToolRuntimeError,
  ): Promise<ToolRuntimeExecuteResult<TDetails>> {
    const endedAt = new Date();
    // 先构造标准化结果，再执行 after hook 和 finished event。
    const output: ToolRuntimeExecuteResult<TDetails> = {
      toolName: input.tool.name,
      toolCallId: input.toolCallId,
      status,
      ...(result ? { result } : {}),
      ...(error ? { error } : {}),
      startedAt,
      endedAt,
      durationMs: endedAt.getTime() - startedAt.getTime(),
    };

    try {
      const lifecycleResult = await lifecycleRunner.afterToolCall({
        tool: input.tool,
        toolCallId: input.toolCallId,
        args: input.args,
        status,
        ...(result ? { result } : {}),
        ...(error ? { error } : {}),
        ...(input.context ? { context: input.context } : {}),
      });
      const finalOutput: ToolRuntimeExecuteResult<TDetails> = lifecycleResult
        ? {
            ...output,
            status: lifecycleResult.status ?? output.status,
            ...(lifecycleResult.result !== undefined ? { result: lifecycleResult.result } : {}),
            ...(lifecycleResult.error !== undefined ? { error: lifecycleResult.error } : {}),
          }
        : output;
      emitToolRuntimeEvent(onEvent, createFinishedEvent(input, finalOutput));
      return finalOutput;
    } catch (hookError) {
      // 非成功态的工具调用已经失败/取消/阻止；after hook 抛错不覆盖原终态。
      if (status !== "succeeded") {
        emitToolRuntimeEvent(onEvent, createFinishedEvent(input, output));
        return output;
      }
      // 成功态 after hook 抛错说明生命周期副作用失败；第一版选择把本次调用标记为 failed。
      const { result: _result, ...failedOutput } = output;
      const failedResult: ToolRuntimeExecuteResult<TDetails> = {
        ...failedOutput,
        status: "failed",
        error: normalizeToolRuntimeError(hookError),
      };
      emitToolRuntimeEvent(onEvent, createFinishedEvent(input, failedResult));
      return failedResult;
    }
  }
}

/**
 * 将原始 AgentTool 包装成带 ToolRuntime 生命周期的 AgentTool。
 *
 * pi-agent-core 仍然调用普通的 `tool.execute(...)`，但实际执行会先经过
 * ToolRuntime，从而获得统一的 before/after/error/abort 行为。
 */
export function wrapToolWithRuntime(
  tool: AgentTool,
  runtime: ToolRuntime,
  context?: ToolRuntimeContext,
  onEvent?: ToolRuntimeEventListener,
): AgentTool {
  return {
    ...tool,
    async execute(toolCallId, params, signal, onUpdate) {
      const execution = await runtime.execute({
        tool,
        toolCallId,
        args: params,
        ...(signal ? { signal } : {}),
        ...(onUpdate ? { onUpdate } : {}),
        ...(onEvent ? { onEvent } : {}),
        ...(context ? { context } : {}),
      });

      if (execution.status === "succeeded" && execution.result) {
        return execution.result;
      }

      throw new Error(
        execution.error?.message ?? `Tool ${tool.name} ${execution.status}.`,
      );
    },
  };
}

export function wrapToolsWithRuntime(
  tools: readonly AgentTool[],
  runtime: ToolRuntime,
  context?: ToolRuntimeContext,
  onEvent?: ToolRuntimeEventListener,
): readonly AgentTool[] {
  return tools.map((tool) =>
    wrapToolWithRuntime(tool, runtime, context, onEvent),
  );
}

// ---------------------------------------------------------------------------
// 内部辅助函数
// ---------------------------------------------------------------------------

/**
 * 执行 ToolPolicy，并处理 rewrite / block / approval。
 *
 * 返回 status=allowed 时，args 是后续工具本体真正应该收到的参数。
 */
async function runToolPolicy(
  policy: ToolPolicy | undefined,
  approvalHandler: ToolApprovalHandler | undefined,
  input: ToolRuntimeExecuteInput,
  onEvent: ToolRuntimeEventListener | undefined,
): Promise<
  | { status: "allowed"; args: unknown }
  | { status: "blocked"; reason: string }
> {
  if (!policy) return { status: "allowed", args: input.args };

  const decision = await policy.decide({
    toolName: input.tool.name,
    toolCallId: input.toolCallId,
    args: input.args,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.context ? { context: input.context } : {}),
  });
  emitToolRuntimeEvent(onEvent, {
    type: ToolRuntimeEventType.PolicyChecked,
    toolName: input.tool.name,
    toolCallId: input.toolCallId,
    args: input.args,
    decision,
    ...(input.context ? { context: input.context } : {}),
    timestamp: new Date(),
  });

  if (decision.type === ToolPolicyDecisionType.Allow) {
    return { status: "allowed", args: input.args };
  }
  if (decision.type === ToolPolicyDecisionType.Rewrite) {
    return { status: "allowed", args: decision.args };
  }
  if (decision.type === ToolPolicyDecisionType.Block) {
    return { status: "blocked", reason: decision.reason };
  }

  emitToolRuntimeEvent(onEvent, {
    type: ToolRuntimeEventType.ApprovalRequested,
    toolName: input.tool.name,
    toolCallId: input.toolCallId,
    args: input.args,
    decision,
    ...(input.context ? { context: input.context } : {}),
    timestamp: new Date(),
  });

  const approved = approvalHandler
    ? await approvalHandler({
        toolName: input.tool.name,
        toolCallId: input.toolCallId,
        args: input.args,
        approval: decision.approval,
        reason: decision.reason,
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.context ? { context: input.context } : {}),
      })
    : false;

  if (approved) {
    emitToolRuntimeEvent(onEvent, {
      type: ToolRuntimeEventType.ApprovalApproved,
      toolName: input.tool.name,
      toolCallId: input.toolCallId,
      args: input.args,
      ...(input.context ? { context: input.context } : {}),
      timestamp: new Date(),
    });
    return { status: "allowed", args: input.args };
  }

  emitToolRuntimeEvent(onEvent, {
    type: ToolRuntimeEventType.ApprovalDenied,
    toolName: input.tool.name,
    toolCallId: input.toolCallId,
    args: input.args,
    reason: decision.reason,
    ...(input.context ? { context: input.context } : {}),
    timestamp: new Date(),
  });
  return { status: "blocked", reason: decision.reason };
}

/**
 * 创建传给工具本体的 update 回调。
 *
 * 这样每个工具无需知道 ToolRuntime 的存在，只要正常调用 onUpdate，
 * Runtime 就能统一产生 `tool_updated` 事件。
 */
function createRuntimeUpdateCallback<TDetails = any>(
  input: ToolRuntimeExecuteInput<TDetails>,
  onEvent: ToolRuntimeEventListener | undefined,
): AgentToolUpdateCallback<TDetails> {
  return (result) => {
    emitToolRuntimeEvent(onEvent, {
      type: ToolRuntimeEventType.Updated,
      toolName: input.tool.name,
      toolCallId: input.toolCallId,
      result,
      ...(input.context ? { context: input.context } : {}),
      timestamp: new Date(),
    });
    input.onUpdate?.(result);
  };
}

/** 从执行结果构造标准化 finished 事件。 */
function createFinishedEvent<TDetails = any>(
  input: ToolRuntimeExecuteInput<TDetails>,
  output: ToolRuntimeExecuteResult<TDetails>,
): ToolRuntimeFinishedEvent<TDetails> {
  return {
    type: ToolRuntimeEventType.Finished,
    toolName: output.toolName,
    toolCallId: output.toolCallId,
    status: output.status,
    ...(output.result ? { result: output.result } : {}),
    ...(output.error ? { error: output.error } : {}),
    ...(input.context ? { context: input.context } : {}),
    startedAt: output.startedAt,
    endedAt: output.endedAt,
    durationMs: output.durationMs,
  };
}

/**
 * 合并 Runtime 默认监听器和单次执行监听器。
 *
 * 默认监听器适合全局审计；单次执行监听器适合 RuntimeAssembler 把事件接入
 * 某个 session 的 EventHub。
 */
function createRuntimeEventListener(
  defaultOnEvent: ToolRuntimeEventListener | undefined,
  inputOnEvent: ToolRuntimeEventListener | undefined,
): ToolRuntimeEventListener | undefined {
  if (!defaultOnEvent) return inputOnEvent;
  if (!inputOnEvent) return defaultOnEvent;
  return (event) => {
    defaultOnEvent(event);
    inputOnEvent(event);
  };
}

/**
 * 安全派发生命周期事件。
 *
 * 事件监听器是观测层，不应反向影响工具执行；因此这里会捕获并忽略监听器异常。
 */
function emitToolRuntimeEvent(
  onEvent: ToolRuntimeEventListener | undefined,
  event: ToolRuntimeEvent,
) {
  try {
    onEvent?.(event);
  } catch {
    // 生命周期事件属于观测层，监听器异常不应该改变工具本身的执行结果。
  }
}

/** 将任意 thrown value 归一化为 Runtime 可序列化的错误形态。 */
function normalizeToolRuntimeError(error: unknown): ToolRuntimeError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  return { message: String(error) };
}
