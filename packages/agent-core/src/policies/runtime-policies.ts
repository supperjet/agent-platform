import type {
  ContextBudgetEstimate,
  ContextPressureStatus,
} from "../context/context-budget.js";
import type {
  ConversationCompactionReason,
  ConversationCompactionSelectionOptions,
  ConversationCompactionSelectionStage,
} from "../conversation/conversation-compactor.js";

export type RuntimeCompactionPolicy =
  | "disabled"
  | {
    readonly mode: "composite";
    readonly pressureStatuses?: readonly ContextPressureStatus[];
    readonly targetTokens?: number;
    readonly targetPressure?: number;
    readonly protectLastMessages?: number;
    readonly recencyHalfLife?: number;
    readonly stages?: readonly ConversationCompactionSelectionStage[];
  };

export type RuntimePolicies = {
  readonly queue: "direct";
  readonly retry: "none";
  readonly compaction: RuntimeCompactionPolicy;
};

/**
 * 策略层产出的可执行压缩决策。
 *
 * Runtime 只负责补充运行时材料，比如 ContextBudget、systemPrompt 和本轮 prompt；
 * 不应该再从 policy 字段手动拼 compactor selection 参数。
 */
export type RuntimeCompactionDecision = {
  readonly reason: Exclude<ConversationCompactionReason, "manual">;
  readonly targetTokens: number;
  readonly metadata: {
    readonly status: ContextPressureStatus;
    readonly pressure: number;
    readonly estimatedTokens: number;
    readonly maxTokens: number;
    readonly remainingTokens: number;
    readonly targetTokens: number;
    readonly protectLastMessages?: number;
  };
  readonly selection: Omit<
    ConversationCompactionSelectionOptions,
    "contextBudget" | "nextMessages" | "systemPrompt"
  >;
};

export const DEFAULT_COMPOSITE_COMPACTION_STAGES: readonly ConversationCompactionSelectionStage[] = [
  { mode: "role-aware" },
  { mode: "largest-first" },
  { mode: "token-budget" },
];

export function createDefaultRuntimePolicies(): RuntimePolicies {
  return {
    queue: "direct",
    retry: "none",
    compaction: "disabled",
  };
}

export function createCompositeCompactionPolicy(options: {
  pressureStatuses?: readonly ContextPressureStatus[];
  targetTokens?: number;
  targetPressure?: number;
  protectLastMessages?: number;
  recencyHalfLife?: number;
  stages?: readonly ConversationCompactionSelectionStage[];
} = {}): RuntimeCompactionPolicy {
  return {
    mode: "composite",
    ...(options.pressureStatuses
      ? { pressureStatuses: options.pressureStatuses }
      : {}),
    ...(options.targetTokens === undefined ? {} : { targetTokens: options.targetTokens }),
    ...(options.targetPressure === undefined ? {} : { targetPressure: options.targetPressure }),
    ...(options.protectLastMessages === undefined
      ? {}
      : { protectLastMessages: options.protectLastMessages }),
    ...(options.recencyHalfLife === undefined ? {} : { recencyHalfLife: options.recencyHalfLife }),
    // 默认 stage 属于 runtime policy，而不是 compactor。compactor 只执行传入的 plan。
    stages: options.stages ?? DEFAULT_COMPOSITE_COMPACTION_STAGES,
  };
}

export function isCompactionPolicyEnabled(
  policy: RuntimeCompactionPolicy,
): policy is Exclude<RuntimeCompactionPolicy, "disabled"> {
  return policy !== "disabled";
}

function shouldCompactForPressure(
  policy: RuntimeCompactionPolicy,
  status: ContextPressureStatus,
): boolean {
  if (!isCompactionPolicyEnabled(policy)) return false;
  const statuses = policy.pressureStatuses ?? ["critical", "overflow"];
  return statuses.includes(status);
}

export function resolveCompactionPolicyDecision(
  policy: RuntimeCompactionPolicy,
  estimate: ContextBudgetEstimate,
): RuntimeCompactionDecision | undefined {
  if (!isCompactionPolicyEnabled(policy)) return undefined;
  if (!shouldCompactForPressure(policy, estimate.status)) return undefined;

  const targetTokens = resolveCompactionTargetTokens(policy, estimate.maxTokens);
  return {
    reason: estimate.status === "overflow" ? "overflow" : "threshold",
    targetTokens,
    metadata: {
      status: estimate.status,
      pressure: estimate.pressure,
      estimatedTokens: estimate.estimatedTokens,
      maxTokens: estimate.maxTokens,
      remainingTokens: estimate.remainingTokens,
      targetTokens,
      ...(policy.protectLastMessages === undefined
        ? {}
        : { protectLastMessages: policy.protectLastMessages }),
    },
    selection: {
      targetTokens,
      ...(policy.protectLastMessages === undefined
        ? {}
        : { protectLastMessages: policy.protectLastMessages }),
      ...(policy.recencyHalfLife === undefined ? {} : { recencyHalfLife: policy.recencyHalfLife }),
      ...(policy.stages ? { stages: policy.stages } : {}),
    },
  };
}

function resolveCompactionTargetTokens(
  policy: Exclude<RuntimeCompactionPolicy, "disabled">,
  maxTokens: number,
): number {
  // Policy accepts either an absolute token target or a pressure ratio; the
  // compactor only receives concrete targetTokens so it stays model-agnostic.
  if (policy.targetTokens !== undefined) return Math.max(1, Math.floor(policy.targetTokens));
  const targetPressure = policy.targetPressure ?? 0.7;
  return Math.max(1, Math.floor(maxTokens * targetPressure));
}
