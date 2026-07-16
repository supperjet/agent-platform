import type { ToolRuntimeContext } from "../tool-runtime.js";

// ---------------------------------------------------------------------------
// Policy 决策模型
// ---------------------------------------------------------------------------

/**
 * ToolPolicy 的标准决策类型。
 *
 * 这里比 beforeHook 的 allow/block 更明确，因为 policy 是工具安全和 approval
 * 边界，而 beforeHook 只是 Runtime 的通用扩展点。
 */
export enum ToolPolicyDecisionType {
  Allow = "allow",
  Block = "block",
  RequireApproval = "require_approval",
  Rewrite = "rewrite",
}

/**
 * 需要交给宿主确认的工具调用请求。
 *
 * agent-core 不负责展示 UI，只描述“需要确认什么”；CLI、server 或 client 可以
 * 根据该结构渲染确认框、审批流或自动化策略。
 */
export type ToolApprovalRequest = {
  id?: string;
  title: string;
  message: string;
  risk?: "low" | "medium" | "high";
  metadata?: Record<string, unknown>;
};

/** ToolPolicy 允许工具继续执行。 */
export type ToolPolicyAllowDecision = {
  type: ToolPolicyDecisionType.Allow;
  reason?: string;
};

/** ToolPolicy 阻止工具执行。 */
export type ToolPolicyBlockDecision = {
  type: ToolPolicyDecisionType.Block;
  reason: string;
  code?: string;
};

/** ToolPolicy 要求宿主先确认，确认通过后才允许执行。 */
export type ToolPolicyRequireApprovalDecision = {
  type: ToolPolicyDecisionType.RequireApproval;
  reason: string;
  approval: ToolApprovalRequest;
};

/**
 * ToolPolicy 改写工具参数。
 *
 * 参考 pi coding-agent 的 mutable input 能力，但这里显式返回新 args，
 * 避免多个 policy 链式执行时出现隐式副作用。
 */
export type ToolPolicyRewriteDecision = {
  type: ToolPolicyDecisionType.Rewrite;
  args: unknown;
  reason?: string;
};

/** ToolPolicy 的完整决策联合类型。 */
export type ToolPolicyDecision =
  | ToolPolicyAllowDecision
  | ToolPolicyBlockDecision
  | ToolPolicyRequireApprovalDecision
  | ToolPolicyRewriteDecision;

/** ToolPolicy 决策时能看到的一次工具调用上下文。 */
export type ToolPolicyInput = {
  toolName: string;
  toolCallId: string;
  args: unknown;
  signal?: AbortSignal;
  context?: ToolRuntimeContext;
};

/**
 * 工具调用前的正式策略接口。
 *
 * ToolPolicy 不执行工具，也不做 UI；它只回答“这次调用下一步应该怎么走”。
 */
export type ToolPolicy = {
  decide(input: ToolPolicyInput): ToolPolicyDecision | Promise<ToolPolicyDecision>;
};

/** approval handler 的输入，包含 policy 给出的确认请求和原始工具调用。 */
export type ToolApprovalInput = ToolPolicyInput & {
  approval: ToolApprovalRequest;
  reason: string;
};

/**
 * 宿主提供的 approval 回调。
 *
 * 返回 true 表示用户/策略批准执行；false 表示拒绝。缺省时，Runtime 会把
 * require_approval 视为 blocked，避免无确认能力时静默执行高风险工具。
 */
export type ToolApprovalHandler = (
  input: ToolApprovalInput,
) => boolean | Promise<boolean>;

/** 方便调用方创建 allow 决策。 */
export function allowTool(reason?: string): ToolPolicyAllowDecision {
  return {
    type: ToolPolicyDecisionType.Allow,
    ...(reason ? { reason } : {}),
  };
}

/** 方便调用方创建 block 决策。 */
export function blockTool(reason: string, code?: string): ToolPolicyBlockDecision {
  return {
    type: ToolPolicyDecisionType.Block,
    reason,
    ...(code ? { code } : {}),
  };
}

/** 方便调用方创建 require_approval 决策。 */
export function requireToolApproval(
  reason: string,
  approval: ToolApprovalRequest,
): ToolPolicyRequireApprovalDecision {
  return {
    type: ToolPolicyDecisionType.RequireApproval,
    reason,
    approval,
  };
}

/** 方便调用方创建 rewrite 决策。 */
export function rewriteToolArgs(args: unknown, reason?: string): ToolPolicyRewriteDecision {
  return {
    type: ToolPolicyDecisionType.Rewrite,
    args,
    ...(reason ? { reason } : {}),
  };
}

/**
 * 顺序组合多个 ToolPolicy。
 *
 * - allow：继续执行后续 policy。
 * - rewrite：用新 args 继续执行后续 policy。
 * - block / require_approval：立即短路返回。
 */
export function createCompositeToolPolicy(policies: readonly ToolPolicy[]): ToolPolicy {
  return {
    async decide(input) {
      let currentInput = input;

      for (const policy of policies) {
        const decision = await policy.decide(currentInput);
        if (decision.type === ToolPolicyDecisionType.Rewrite) {
          currentInput = {
            ...currentInput,
            args: decision.args,
          };
          continue;
        }
        if (decision.type !== ToolPolicyDecisionType.Allow) {
          return decision;
        }
      }

      return allowTool();
    },
  };
}
