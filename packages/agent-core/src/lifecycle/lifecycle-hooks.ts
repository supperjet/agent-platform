import type {
  AgentMessage,
  AgentTool,
  AgentToolResult,
} from "@earendil-works/pi-agent-core";
import type { AgentRuntimeCommand } from "../contracts.js";
import type {
  ToolRuntimeContext,
  ToolRuntimeError,
  ToolRuntimeStatus,
} from "../tools/tool-runtime.js";

/**
 * 外部输入进入 runtime 后、被转换成标准 user message 前执行。
 *
 * 执行节点：
 * AgentRuntimeSession.execute(command)
 *   -> TurnRunner.run(command)
 *   -> LifecycleRunner.onInput(...)
 *
 * 作用：
 * - 规范化用户输入。
 * - 展开 prompt template 或 skill command。
 * - 在输入已被内部能力处理时短路本轮执行。
 *
 * 返回语义：
 * - `continue`：沿用当前 command。
 * - `transform`：替换后续流程看到的 command。
 * - `handled`：输入已处理，不再发送给模型。
 */
export type InputHook = (
  input: InputHookInput,
) => InputHookResult | Promise<InputHookResult>;

export type InputHookInput = {
  command: AgentRuntimeCommand;
};

export type InputHookResult =
  | void
  | { action: "continue" }
  | { action: "transform"; command: AgentRuntimeCommand }
  | { action: "handled" };

/**
 * 输入已经确定、准备启动本轮 agent loop 前执行。
 *
 * 执行节点：
 * TurnRunner.run(command)
 *   -> InputProcessor.normalize(...)
 *   -> LifecycleRunner.beforeRun(...)
 *   -> ContextAssembler.assemble(...)
 *
 * 作用：
 * - 为本轮执行追加内部 custom message。
 * - 基于静态 PromptPlan 生成本轮临时 system prompt override。
 * - 写入 run 级 metadata 或诊断信息。
 *
 * 返回语义：
 * - 可追加 `messages`。
 * - 可返回 `systemPrompt` 覆盖本轮 system prompt；不会污染 base PromptPlan。
 */
export type BeforeRunHook = (
  input: BeforeRunHookInput,
) => BeforeRunHookResult | Promise<BeforeRunHookResult>;

export type BeforeRunHookInput = {
  command: AgentRuntimeCommand;
  systemPrompt: string;
  metadata?: Record<string, unknown>;
};

export type BeforeRunHookResult = void | {
  messages?: readonly AgentMessage[];
  systemPrompt?: string;
  metadata?: Record<string, unknown>;
};

/**
 * 每次 LLM 调用前、conversation/context 已投影但还没交给模型前执行。
 *
 * 执行节点：
 * ContextAssembler.assemble(...)
 *   -> LifecycleRunner.beforeContext(...)
 *   -> AgentLoopAdapter.run(...)
 *
 * 作用：
 * - 注入 memory recall、active skill 正文或临时上下文材料。
 * - 根据 context budget 改写或裁剪 messages。
 * - 对本次 LLM call 的 system prompt 做临时覆盖。
 *
 * 返回语义：
 * - 可替换 `messages`。当前 TurnRunner 接线要求保留已有 conversation 前缀，
 *   只把前缀之后的消息作为本次 prompt 批次传给 loop。
 * - 可替换本次调用使用的 `systemPrompt`。
 * - 多个 hook 按注册顺序串行，后一个 hook 看到前一个 hook 的结果。
 */
export type BeforeContextHook = (
  input: BeforeContextHookInput,
) => BeforeContextHookResult | Promise<BeforeContextHookResult>;

export type BeforeContextHookInput = {
  systemPrompt: string;
  messages: readonly AgentMessage[];
  metadata?: Record<string, unknown>;
};

export type BeforeContextHookResult = void | {
  systemPrompt?: string;
  messages?: readonly AgentMessage[];
  metadata?: Record<string, unknown>;
};

/**
 * 模型请求工具调用后、ToolRuntime 执行具体工具实现前执行。
 *
 * 执行节点：
 * AgentLoopAdapter 接收到 model tool call
 *   -> ToolRuntime.execute(...)
 *   -> LifecycleRunner.beforeToolCall(...)
 *   -> tool.execute(...)
 *
 * 作用：
 * - 检查或改写工具参数。
 * - 执行 permission / policy / audit 预检。
 * - 阻止不允许执行的工具调用。
 *
 * 返回语义：
 * - `undefined` / `true` / `{ allow: true }`：继续执行。
 * - `false` / `{ allow: false }`：短路工具调用，返回 blocked。
 * - `{ args }`：替换后续 hook 和工具本体收到的参数。
 */
export type BeforeToolCallHook = (
  input: BeforeToolCallHookInput,
) => BeforeToolCallHookResult | Promise<BeforeToolCallHookResult>;

export type BeforeToolCallHookInput<TDetails = any> = {
  tool: AgentTool<any, TDetails>;
  toolCallId: string;
  args: unknown;
  signal?: AbortSignal;
  context?: ToolRuntimeContext;
};

export type BeforeToolCallHookResult =
  | void
  | boolean
  | {
      allow?: boolean;
      args?: unknown;
      reason?: string;
    };

/**
 * 工具本体执行完、ToolRuntime 发布终态事件或把结果交回模型前执行。
 *
 * 执行节点：
 * tool.execute(...)
 *   -> ToolRuntime 形成标准化执行结果
 *   -> LifecycleRunner.afterToolCall(...)
 *   -> ToolRuntime 发布 tool_finished / 返回结果
 *
 * 作用：
 * - 清洗工具输出，隐藏敏感信息。
 * - 补充或改写 structured details。
 * - 将工具结果标记为 error，或把 error 恢复成可消费结果。
 *
 * 返回语义：
 * - 可改写 `result`、`status`、`error`。
 * - hook 抛错时由 ToolRuntime 决定是否覆盖原终态。
 */
export type AfterToolCallHook = (
  input: AfterToolCallHookInput,
) => AfterToolCallHookResult | Promise<AfterToolCallHookResult>;

export type AfterToolCallHookInput<TDetails = any> = {
  tool: AgentTool<any, TDetails>;
  toolCallId: string;
  args: unknown;
  status: ToolRuntimeStatus;
  result?: AgentToolResult<TDetails>;
  error?: ToolRuntimeError;
  context?: ToolRuntimeContext;
};

export type AfterToolCallHookResult<TDetails = any> = void | {
  status?: ToolRuntimeStatus;
  result?: AgentToolResult<TDetails>;
  error?: ToolRuntimeError;
};

/**
 * 一条 message 已经完成、写入 conversation 或对外固定前执行。
 *
 * 执行节点：
 * AgentLoopAdapter 收到 finalized message
 *   -> LifecycleRunner.afterMessage(...)
 *   -> ConversationStore / EventHub 同步 message
 *
 * 作用：
 * - 标准化 assistant/tool/user message。
 * - 抽取 artifact 或 memory candidate。
 * - 在不改变 role 的前提下替换 message 内容。
 *
 * 返回语义：
 * - 可返回同 role 的替换 message。
 */
export type AfterMessageHook = (
  input: AfterMessageHookInput,
) => AfterMessageHookResult | Promise<AfterMessageHookResult>;

export type AfterMessageHookInput = {
  message: AgentMessage;
  metadata?: Record<string, unknown>;
};

export type AfterMessageHookResult = void | {
  message?: AgentMessage;
  metadata?: Record<string, unknown>;
};

/**
 * 准备压缩 conversation 前执行。
 *
 * 执行节点：
 * TurnRunner 检测到 manual / threshold / overflow compaction
 *   -> LifecycleRunner.beforeCompaction(...)
 *   -> CompactionPolicy.compact(...)
 *
 * 作用：
 * - 允许或取消本次压缩。
 * - 注入 compaction hint 或自定义压缩指令。
 * - 记录压缩前诊断信息。
 *
 * 返回语义：
 * - `cancel: true`：取消本次压缩。
 * - `instructions`：提供本次压缩使用的附加指令。
 */
export type BeforeCompactionHook = (
  input: BeforeCompactionHookInput,
) => BeforeCompactionHookResult | Promise<BeforeCompactionHookResult>;

export type BeforeCompactionHookInput = {
  reason: "manual" | "threshold" | "overflow";
  willRetry: boolean;
  metadata?: Record<string, unknown>;
};

export type BeforeCompactionHookResult = void | {
  cancel?: boolean;
  instructions?: string;
  metadata?: Record<string, unknown>;
};

/**
 * 本次 run 已进入终态后执行。
 *
 * 执行节点：
 * AgentLoopAdapter.run(...) 完成
 *   -> StateExporter / EventHub 同步终态
 *   -> LifecycleRunner.afterRun(...)
 *
 * 作用：
 * - 清理本轮临时资源。
 * - 汇总 diagnostics。
 * - 触发不影响主流程的异步 side effect。
 *
 * 返回语义：
 * - 通知型 hook，不改写 run 结果。
 */
export type AfterRunHook = (
  input: AfterRunHookInput,
) => void | Promise<void>;

export type AfterRunHookInput = {
  status: "succeeded" | "failed" | "aborted";
  metadata?: Record<string, unknown>;
};

/**
 * agent-core 第一版内部生命周期 hook 集合。
 *
 * 这里是唯一 hook 定义层。执行模块只在自己的节点调用 LifecycleRunner，
 * 不再各自维护平行的 before/after hook 语义。
 */
export type LifecycleHooks = {
  readonly onInput?: readonly InputHook[];
  readonly beforeRun?: readonly BeforeRunHook[];
  readonly beforeContext?: readonly BeforeContextHook[];
  readonly beforeToolCall?: readonly BeforeToolCallHook[];
  readonly afterToolCall?: readonly AfterToolCallHook[];
  readonly afterMessage?: readonly AfterMessageHook[];
  readonly beforeCompaction?: readonly BeforeCompactionHook[];
  readonly afterRun?: readonly AfterRunHook[];
};

export function createDefaultLifecycleHooks(): LifecycleHooks {
  return {};
}
