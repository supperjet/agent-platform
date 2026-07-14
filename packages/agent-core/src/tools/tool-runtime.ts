import type {
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@earendil-works/pi-agent-core";

export type ToolRuntimeStatus = "succeeded" | "failed" | "aborted" | "blocked";

export type ToolRuntimeContext = {
  sessionId?: string;
  definitionId?: string;
  metadata?: Record<string, unknown>;
};

export type ToolRuntimeError = {
  name?: string;
  message: string;
  stack?: string;
};

export type ToolRuntimeExecuteInput<TDetails = any> = {
  tool: AgentTool<any, TDetails>;
  toolCallId: string;
  args: unknown;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback<TDetails>;
  context?: ToolRuntimeContext;
};

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

export type BeforeToolCallInput<TDetails = any> = {
  tool: AgentTool<any, TDetails>;
  toolCallId: string;
  args: unknown;
  signal?: AbortSignal;
  context?: ToolRuntimeContext;
};

export type BeforeToolCallDecision =
  | void
  | boolean
  | {
      allow: boolean;
      reason?: string;
    };

export type BeforeToolCallHook = (
  input: BeforeToolCallInput,
) => BeforeToolCallDecision | Promise<BeforeToolCallDecision>;

export type AfterToolCallInput<TDetails = any> = {
  tool: AgentTool<any, TDetails>;
  toolCallId: string;
  args: unknown;
  status: ToolRuntimeStatus;
  result?: AgentToolResult<TDetails>;
  error?: ToolRuntimeError;
  context?: ToolRuntimeContext;
};

export type AfterToolCallHook = (
  input: AfterToolCallInput,
) => void | Promise<void>;

export type ToolRuntimeOptions = {
  beforeToolCall?: readonly BeforeToolCallHook[];
  afterToolCall?: readonly AfterToolCallHook[];
};

export type ToolRuntime = {
  execute<TDetails = any>(
    input: ToolRuntimeExecuteInput<TDetails>,
  ): Promise<ToolRuntimeExecuteResult<TDetails>>;
};

/**
 * 创建默认工具运行时。
 *
 * ToolRuntime 不负责注册或选择工具，只负责包住一次工具调用：
 * before hook -> 原始 tool.execute -> after hook -> 结构化执行结果。
 */
export function createToolRuntime(
  options: ToolRuntimeOptions = {},
): ToolRuntime {
  const beforeHooks = options.beforeToolCall ?? [];
  const afterHooks = options.afterToolCall ?? [];

  return {
    async execute<TDetails = any>(
      input: ToolRuntimeExecuteInput<TDetails>,
    ): Promise<ToolRuntimeExecuteResult<TDetails>> {
      const startedAt = new Date();

      try {
        if (input.signal?.aborted) {
          return finish(input, "aborted", startedAt, undefined, {
            name: "AbortError",
            message: "Tool execution aborted.",
          });
        }

        const blockReason = await runBeforeHooks(beforeHooks, input);
        if (blockReason) {
          return finish(input, "blocked", startedAt, undefined, {
            name: "ToolBlockedError",
            message: blockReason,
          });
        }

        const result = await input.tool.execute(
          input.toolCallId,
          input.args as never,
          input.signal,
          input.onUpdate,
        );
        return finish(input, "succeeded", startedAt, result);
      } catch (error) {
        return finish(
          input,
          input.signal?.aborted ? "aborted" : "failed",
          startedAt,
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
    result?: AgentToolResult<TDetails>,
    error?: ToolRuntimeError,
  ): Promise<ToolRuntimeExecuteResult<TDetails>> {
    const endedAt = new Date();
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
      await runAfterHooks(afterHooks, {
        tool: input.tool,
        toolCallId: input.toolCallId,
        args: input.args,
        status,
        ...(result ? { result } : {}),
        ...(error ? { error } : {}),
        ...(input.context ? { context: input.context } : {}),
      });
      return output;
    } catch (hookError) {
      if (status !== "succeeded") return output;
      const { result: _result, ...failedOutput } = output;
      return {
        ...failedOutput,
        status: "failed",
        error: normalizeToolRuntimeError(hookError),
      };
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
): readonly AgentTool[] {
  return tools.map((tool) => wrapToolWithRuntime(tool, runtime, context));
}

async function runBeforeHooks(
  hooks: readonly BeforeToolCallHook[],
  input: BeforeToolCallInput,
): Promise<string | undefined> {
  for (const hook of hooks) {
    const decision = normalizeBeforeDecision(await hook(input));
    if (!decision.allow) return decision.reason ?? "Tool call blocked.";
  }
  return undefined;
}

async function runAfterHooks(
  hooks: readonly AfterToolCallHook[],
  input: AfterToolCallInput,
) {
  for (const hook of hooks) {
    await hook(input);
  }
}

function normalizeBeforeDecision(decision: BeforeToolCallDecision): {
  allow: boolean;
  reason?: string;
} {
  if (decision === undefined) return { allow: true };
  if (typeof decision === "boolean") return { allow: decision };
  return {
    allow: decision.allow,
    ...(decision.reason ? { reason: decision.reason } : {}),
  };
}

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
