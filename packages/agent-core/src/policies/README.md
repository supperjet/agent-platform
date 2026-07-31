# Policies

Owns runtime decision policies such as queueing, retry, and compaction.

Policies answer control-flow questions for `TurnRunner`; they do not execute tools or call providers directly.

`RuntimePolicies.compaction` is disabled by default.

`createCompositeCompactionPolicy(...)` separates the trigger from source
selection. The trigger still uses `ContextBudget` pressure diagnostics, while
the compactor planner selects source message groups toward `targetTokens` or
`targetPressure`. Its default stages are role-aware, largest-first, and
token-budget selection, with dependency-aware grouping for assistant tool calls
and matching tool results. Use the `keep-last` stage when a policy should compact
older messages while preserving the latest N messages.

Default stages are filled by `createCompositeCompactionPolicy(...)`, not by the
compactor. That keeps runtime policy defaults visible at the policy boundary,
while `conversation-compactor` only executes the supplied selection plan.

Use `resolveCompactionPolicyDecision(...)` at runtime. It returns no decision
when compaction is disabled or outside the configured pressure statuses; when it
does return a decision, it includes the compaction reason, target tokens,
lifecycle metadata, and planner selection parameters. Callers should not
reconstruct policy fields by hand before calling the compactor.
