import assert from "node:assert/strict";
import test from "node:test";
import type { ContextBudgetEstimate } from "../context/context-budget.js";
import {
  DEFAULT_COMPOSITE_COMPACTION_STAGES,
  createCompositeCompactionPolicy,
  resolveCompactionPolicyDecision,
} from "../policies/runtime-policies.js";

test("composite compaction policy fills default stages at creation time", () => {
  const policy = createCompositeCompactionPolicy();

  assert.deepEqual(policy, {
    mode: "composite",
    stages: DEFAULT_COMPOSITE_COMPACTION_STAGES,
  });
});

test("compaction policy resolves trigger and selection parameters together", () => {
  const policy = createCompositeCompactionPolicy({
    pressureStatuses: ["critical"],
    targetPressure: 0.6,
    protectLastMessages: 3,
    recencyHalfLife: 5,
    stages: [
      { mode: "keep-last" },
      { mode: "largest-first", protectLastMessages: 2 },
      { mode: "token-budget" },
    ],
  });

  const decision = resolveCompactionPolicyDecision(policy, createEstimate({
    status: "critical",
    estimatedTokens: 900,
    maxTokens: 1000,
    remainingTokens: 100,
  }));

  assert.deepEqual(decision, {
    reason: "threshold",
    targetTokens: 600,
    metadata: {
      status: "critical",
      pressure: 0.9,
      estimatedTokens: 900,
      maxTokens: 1000,
      remainingTokens: 100,
      targetTokens: 600,
      protectLastMessages: 3,
    },
    selection: {
      targetTokens: 600,
      protectLastMessages: 3,
      recencyHalfLife: 5,
      stages: [
        { mode: "keep-last" },
        { mode: "largest-first", protectLastMessages: 2 },
        { mode: "token-budget" },
      ],
    },
  });
});

test("compaction policy returns no decision when disabled or outside pressure statuses", () => {
  assert.equal(
    resolveCompactionPolicyDecision("disabled", createEstimate({ status: "overflow" })),
    undefined,
  );
  assert.equal(
    resolveCompactionPolicyDecision(
      createCompositeCompactionPolicy({ pressureStatuses: ["overflow"] }),
      createEstimate({ status: "critical" }),
    ),
    undefined,
  );
});

function createEstimate(
  input: Partial<ContextBudgetEstimate>,
): ContextBudgetEstimate {
  const maxTokens = input.maxTokens ?? 1000;
  const estimatedTokens = input.estimatedTokens ?? 100;
  return {
    messageCount: 1,
    estimatedCharacters: 100,
    systemPromptCharacters: 0,
    totalEstimatedCharacters: 100,
    estimatedTokens,
    maxTokens,
    remainingTokens: input.remainingTokens ?? (maxTokens - estimatedTokens),
    pressure: input.pressure ?? (estimatedTokens / maxTokens),
    overflow: input.overflow ?? estimatedTokens > maxTokens,
    status: input.status ?? "normal",
    shouldCompact: input.shouldCompact ?? false,
    recommendedAction: input.recommendedAction ?? "none",
    budgetSource: "configured",
    model: {
      maxContextTokens: maxTokens,
      reservedOutputTokens: 0,
      safetyMarginTokens: 0,
    },
    largestMessages: [],
  };
}
