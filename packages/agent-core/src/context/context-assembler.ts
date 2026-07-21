import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentRuntimeCommand } from "../contracts.js";
import type { LifecycleRunner } from "../lifecycle/lifecycle-runner.js";
import { createUserMessage } from "../runtime/messages.js";
import { ContextBudget, type ContextBudgetEstimate } from "./context-budget.js";

export type PromptRuntimeCommand = Extract<AgentRuntimeCommand, { type: "prompt" }>;

export type ContextAssemblerInput = {
  /** 当前 prompt 命令；第一版 ContextAssembler 只处理完整 prompt turn。 */
  command: PromptRuntimeCommand;
  /** 静态 PromptAssembler 产出的 base system prompt。 */
  baseSystemPrompt: string;
  /** 当前 conversation 投影出来的历史消息前缀。 */
  conversationMessages: readonly AgentMessage[];
};

export type TurnContextMetadata = {
  /** beforeRun / beforeContext hook 写入的运行期元数据。 */
  hooks?: Record<string, unknown>;
  /** 第一版上下文预算估算结果，只用于观测，不做裁剪。 */
  budget: ContextBudgetEstimate;
};

export type TurnContext = {
  /** 当前 turn 实际传给模型的 system prompt，可被 lifecycle 临时覆盖。 */
  systemPrompt: string;
  /** 当前 turn 需要追加给 AgentLoop 的消息，不包含已有 conversation 前缀。 */
  promptMessages: AgentMessage[];
  /** 包含 conversation 前缀和 promptMessages 的完整上下文视图。 */
  messages: readonly AgentMessage[];
  metadata: TurnContextMetadata;
};

export type ContextAssemblerOptions = {
  /** 生命周期执行器；ContextAssembler 负责 beforeRun / beforeContext 两个控制点。 */
  lifecycleRunner?: LifecycleRunner;
  /** 上下文预算估算器；第一版默认只统计数量和字符数。 */
  contextBudget?: ContextBudget;
};

/**
 * ContextAssembler 是每个 prompt turn 的上下文装配中心。
 *
 * 执行流程：
 * 1. 把 prompt command 转换为标准 user message。
 * 2. 执行 lifecycle.beforeRun，允许追加 run 级消息和临时 systemPrompt。
 * 3. 拼出 conversation 历史前缀 + 本轮 prompt 消息，形成完整上下文视图。
 * 4. 执行 lifecycle.beforeContext，允许追加/改写本轮上下文和 systemPrompt。
 * 5. 校验 hook 没有移除或替换已有 conversation 前缀，再输出本轮要交给 AgentLoop 的消息。
 *
 * 注意：当前底层 AgentLoop.prompt 只接收“本轮新增消息”，已有历史由 loop 内部维护。
 * 因此 beforeContext 可以追加临时消息，但必须保留 conversationMessages 这个前缀。
 */
export class ContextAssembler {
  private readonly contextBudget: ContextBudget;

  constructor(private readonly options: ContextAssemblerOptions = {}) {
    this.contextBudget = options.contextBudget ?? new ContextBudget();
  }

  async assemble(input: ContextAssemblerInput): Promise<TurnContext> {
    const userMessage = createUserMessage(input.command.text);
    let systemPrompt = input.baseSystemPrompt;
    let promptMessages: AgentMessage[] = [userMessage];
    let hookMetadata: Record<string, unknown> | undefined;

    const beforeRunResult = await this.options.lifecycleRunner?.beforeRun({
      command: input.command,
      systemPrompt,
    });
    if (beforeRunResult?.systemPrompt !== undefined) {
      systemPrompt = beforeRunResult.systemPrompt;
    }
    if (beforeRunResult?.messages?.length) {
      promptMessages = [...beforeRunResult.messages, userMessage];
    }
    if (beforeRunResult?.metadata) {
      hookMetadata = mergeMetadata(hookMetadata, beforeRunResult.metadata);
    }

    let contextMessages: readonly AgentMessage[] = [
      ...input.conversationMessages,
      ...promptMessages,
    ];
    const beforeContextResult = await this.options.lifecycleRunner?.beforeContext({
      systemPrompt,
      messages: contextMessages,
      ...(hookMetadata ? { metadata: hookMetadata } : {}),
    });
    if (beforeContextResult?.systemPrompt !== undefined) {
      systemPrompt = beforeContextResult.systemPrompt;
    }
    if (beforeContextResult?.messages !== undefined) {
      contextMessages = beforeContextResult.messages;
      promptMessages = projectPromptMessages(input.conversationMessages, contextMessages);
    }
    if (beforeContextResult?.metadata) {
      hookMetadata = mergeMetadata(hookMetadata, beforeContextResult.metadata);
    }

    return {
      systemPrompt,
      promptMessages,
      messages: contextMessages,
      metadata: {
        ...(hookMetadata ? { hooks: hookMetadata } : {}),
        budget: this.contextBudget.estimate(contextMessages),
      },
    };
  }
}

function projectPromptMessages(
  conversationMessages: readonly AgentMessage[],
  nextContextMessages: readonly AgentMessage[],
): AgentMessage[] {
  if (nextContextMessages.length < conversationMessages.length) {
    throw new Error("beforeContext cannot remove existing conversation messages in the current ContextAssembler wiring.");
  }

  for (let index = 0; index < conversationMessages.length; index++) {
    if (nextContextMessages[index] !== conversationMessages[index]) {
      throw new Error("beforeContext must preserve the existing conversation prefix in the current ContextAssembler wiring.");
    }
  }

  return nextContextMessages.slice(conversationMessages.length);
}

function mergeMetadata(
  currentMetadata: Record<string, unknown> | undefined,
  nextMetadata: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...currentMetadata,
    ...nextMetadata,
  };
}
