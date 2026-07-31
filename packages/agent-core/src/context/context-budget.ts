import type { AgentMessage } from "@earendil-works/pi-agent-core";

export type ContextPressureStatus = "normal" | "pressured" | "critical" | "overflow";

export type ContextBudgetModelProfile = {
  provider?: string;
  modelId?: string;
  /** 模型完整上下文窗口。 */
  maxContextTokens?: number;
  /** 模型单次输出上限；预算会优先从上下文窗口中预留这部分。 */
  maxOutputTokens?: number;
};

export type ContextTokenEstimatorInput = {
  message: AgentMessage;
  text: string;
  characterCount: number;
  index: number;
};

export type ContextTokenEstimator = (
  input: ContextTokenEstimatorInput,
) => number;

export type ContextBudgetOptions = {
  model?: ContextBudgetModelProfile;
  /** 直接覆盖可用输入 token 上限；主要用于测试或上层精确配置。 */
  maxTokens?: number;
  /** 没有模型上下文窗口时的保守 fallback。 */
  defaultMaxContextTokens?: number;
  /** 为模型输出预留的 token。 */
  reservedOutputTokens?: number;
  /** 安全余量，避免估算误差直接撞上 provider context limit。 */
  safetyMarginTokens?: number;
  warningRatio?: number;
  criticalRatio?: number;
  tokenEstimator?: ContextTokenEstimator;
  largestMessageLimit?: number;
};

export type ContextBudgetEstimate = {
  /** 本次上下文中的消息数量。 */
  messageCount: number;
  /** message 文本字符数，不含 system prompt。 */
  estimatedCharacters: number;
  /** system prompt 字符数。 */
  systemPromptCharacters: number;
  /** message + system prompt 的总字符数。 */
  totalEstimatedCharacters: number;
  /** 基于估算器得到的输入 token 近似值。 */
  estimatedTokens: number;
  /** 当前可用于输入的 token 预算。 */
  maxTokens: number;
  /** 剩余输入 token；overflow 时为负数。 */
  remainingTokens: number;
  /** estimatedTokens / maxTokens。 */
  pressure: number;
  /** 是否已经超过可用输入预算。 */
  overflow: boolean;
  /** 面向策略层的压力分级。 */
  status: ContextPressureStatus;
  /** 是否建议压缩；E.2 只诊断，不执行。 */
  shouldCompact: boolean;
  recommendedAction: "none" | "compact";
  /** 本次预算来自真实模型窗口还是 fallback/default。 */
  budgetSource: "configured" | "model" | "default";
  model?: {
    provider?: string;
    modelId?: string;
    maxContextTokens: number;
    reservedOutputTokens: number;
    safetyMarginTokens: number;
  };
  largestMessages: Array<{
    index: number;
    role: string;
    estimatedCharacters: number;
    estimatedTokens: number;
  }>;
};

export type ContextBudgetEstimateInput = {
  systemPrompt?: string;
};

type ResolvedContextBudgetOptions = Required<Pick<
  ContextBudgetOptions,
  "defaultMaxContextTokens" |
  "reservedOutputTokens" |
  "safetyMarginTokens" |
  "warningRatio" |
  "criticalRatio" |
  "largestMessageLimit"
>> & Omit<ContextBudgetOptions, "defaultMaxContextTokens" | "reservedOutputTokens" | "safetyMarginTokens" | "warningRatio" | "criticalRatio" | "largestMessageLimit">;

/**
 * ContextBudget 负责估算每轮上下文成本。
 *
 * 预算估算只做只读诊断，不裁剪、不改写 messages。这样 ContextAssembler 可以先把
 * budget 信息放进 metadata，后续再逐步接入资源选择、memory 裁剪和会话压缩策略。
 */
export class ContextBudget {
  private readonly options: ResolvedContextBudgetOptions;

  constructor(options: ContextBudgetOptions = {}) {
    this.options = {
      defaultMaxContextTokens: options.defaultMaxContextTokens ?? 128_000,
      reservedOutputTokens: options.reservedOutputTokens ?? inferReservedOutputTokens(options.model),
      safetyMarginTokens: options.safetyMarginTokens ?? 1_024,
      warningRatio: options.warningRatio ?? 0.7,
      criticalRatio: options.criticalRatio ?? 0.85,
      largestMessageLimit: options.largestMessageLimit ?? 5,
      ...(options.model ? { model: options.model } : {}),
      ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
      ...(options.tokenEstimator ? { tokenEstimator: options.tokenEstimator } : {}),
    };
  }

  estimate(
    messages: readonly AgentMessage[],
    input: ContextBudgetEstimateInput = {},
  ): ContextBudgetEstimate {
    const messageEstimates = messages.map((message, index) => {
      const text = readMessageText(message);
      const estimatedCharacters = text.length;
      const estimatedTokens = estimateMessageTokens(message, text, estimatedCharacters, index, this.options.tokenEstimator);
      return {
        index,
        role: readMessageRole(message),
        estimatedCharacters,
        estimatedTokens,
      };
    });
    const estimatedCharacters = messageEstimates.reduce(
      (total, message) => total + message.estimatedCharacters,
      0,
    );
    const messageTokens = messageEstimates.reduce(
      (total, message) => total + message.estimatedTokens,
      0,
    );
    const systemPromptCharacters = input.systemPrompt?.length ?? 0;
    const systemPromptTokens = systemPromptCharacters > 0
      ? estimateTextTokens(input.systemPrompt ?? "") + 8
      : 0;
    const budget = resolveTokenBudget(this.options);
    const estimatedTokens = Math.ceil(messageTokens + systemPromptTokens);
    const remainingTokens = budget.maxTokens - estimatedTokens;
    const pressure = budget.maxTokens > 0 ? estimatedTokens / budget.maxTokens : 1;
    const status = classifyPressure({
      pressure,
      overflow: remainingTokens < 0,
      warningRatio: this.options.warningRatio,
      criticalRatio: this.options.criticalRatio,
    });

    return {
      messageCount: messages.length,
      estimatedCharacters,
      systemPromptCharacters,
      totalEstimatedCharacters: estimatedCharacters + systemPromptCharacters,
      estimatedTokens,
      maxTokens: budget.maxTokens,
      remainingTokens,
      pressure,
      overflow: remainingTokens < 0,
      status,
      shouldCompact: status === "critical" || status === "overflow",
      recommendedAction: status === "critical" || status === "overflow"
        ? "compact"
        : "none",
      budgetSource: budget.source,
      model: {
        ...("provider" in budget ? { provider: budget.provider } : {}),
        ...("modelId" in budget ? { modelId: budget.modelId } : {}),
        maxContextTokens: budget.maxContextTokens,
        reservedOutputTokens: budget.reservedOutputTokens,
        safetyMarginTokens: budget.safetyMarginTokens,
      },
      largestMessages: [...messageEstimates]
        .sort((left, right) => right.estimatedTokens - left.estimatedTokens)
        .slice(0, this.options.largestMessageLimit),
    };
  }
}

export function createContextBudgetForModel(
  model: ContextBudgetModelProfile,
  options: Omit<ContextBudgetOptions, "model"> = {},
): ContextBudget {
  return new ContextBudget({
    ...options,
    model,
  });
}

function resolveTokenBudget(options: ResolvedContextBudgetOptions): {
  maxTokens: number;
  maxContextTokens: number;
  reservedOutputTokens: number;
  safetyMarginTokens: number;
  source: "configured" | "model" | "default";
  provider?: string;
  modelId?: string;
} {
  if (options.maxTokens !== undefined) {
    return {
      maxTokens: Math.max(1, Math.floor(options.maxTokens)),
      maxContextTokens: Math.max(1, Math.floor(options.maxTokens)),
      reservedOutputTokens: 0,
      safetyMarginTokens: 0,
      source: "configured",
      ...(options.model?.provider ? { provider: options.model.provider } : {}),
      ...(options.model?.modelId ? { modelId: options.model.modelId } : {}),
    };
  }

  const modelWindow = options.model?.maxContextTokens;
  const maxContextTokens = modelWindow !== undefined && modelWindow > 0
    ? modelWindow
    : options.defaultMaxContextTokens;
  const maxTokens = Math.max(
    1,
    Math.floor(maxContextTokens - options.reservedOutputTokens - options.safetyMarginTokens),
  );

  return {
    maxTokens,
    maxContextTokens,
    reservedOutputTokens: options.reservedOutputTokens,
    safetyMarginTokens: options.safetyMarginTokens,
    source: modelWindow !== undefined && modelWindow > 0 ? "model" : "default",
    ...(options.model?.provider ? { provider: options.model.provider } : {}),
    ...(options.model?.modelId ? { modelId: options.model.modelId } : {}),
  };
}

function inferReservedOutputTokens(
  model: ContextBudgetModelProfile | undefined,
): number {
  if (model?.maxOutputTokens !== undefined && model.maxOutputTokens > 0) {
    return Math.min(model.maxOutputTokens, 4_096);
  }
  return 4_096;
}

function estimateMessageTokens(
  message: AgentMessage,
  text: string,
  characterCount: number,
  index: number,
  estimator: ContextTokenEstimator | undefined,
): number {
  const estimate = estimator
    ? estimator({ message, text, characterCount, index })
    : estimateTextTokens(text);
  return Math.max(0, Math.ceil(estimate + 8));
}

function estimateTextTokens(text: string): number {
  let cjkCharacters = 0;
  let whitespaceCharacters = 0;
  let symbolCharacters = 0;
  for (const character of text) {
    if (/[\u3400-\u9fff\uf900-\ufaff]/u.test(character)) {
      cjkCharacters += 1;
    } else if (/\s/u.test(character)) {
      whitespaceCharacters += 1;
    } else if (/[{}[\]():;,.="'`<>/\\|-]/u.test(character)) {
      symbolCharacters += 1;
    }
  }
  const nonCjkCharacters = Math.max(0, text.length - cjkCharacters - whitespaceCharacters - symbolCharacters);
  return Math.max(
    Math.ceil(text.length / 3),
    Math.ceil(
      (cjkCharacters * 1.05)
      + (nonCjkCharacters / 3.5)
      + (whitespaceCharacters / 4)
      + (symbolCharacters / 2),
    ),
  );
}

function classifyPressure(input: {
  pressure: number;
  overflow: boolean;
  warningRatio: number;
  criticalRatio: number;
}): ContextPressureStatus {
  if (input.overflow || input.pressure >= 1) return "overflow";
  if (input.pressure >= input.criticalRatio) return "critical";
  if (input.pressure >= input.warningRatio) return "pressured";
  return "normal";
}

function readMessageRole(message: AgentMessage): string {
  return typeof message.role === "string" ? message.role : "unknown";
}

function readMessageText(message: AgentMessage): string {
  if (!("content" in message)) return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";

  return message.content.flatMap((block) => {
    if (!block || typeof block !== "object") return [];
    if ("text" in block && typeof block.text === "string") return [block.text];
    return [];
  }).join("\n");
}
