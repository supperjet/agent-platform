# Lifecycle

`lifecycle/` owns the internal hook contract for the agent-core runtime.

It is the single place where execution-time extension points are defined and
sequenced. Runtime modules call `LifecycleRunner` at their own execution nodes,
but they should not maintain parallel hook chains.

## Purpose

Lifecycle exists to keep the run pipeline extensible without spreading hook
logic across `TurnRunner`, `ContextAssembler`, `ToolRuntime`, policies, and
future memory/skill modules.

It answers questions such as:

- Should this input continue into the agent loop?
- Should this input or context be rewritten before the model sees it?
- Should this tool call be blocked or should its args be rewritten?
- Should a tool result or finalized message be sanitized before it becomes
  stable runtime state?
- Should compaction be cancelled or customized?

It does not own:

- Public runtime event projection. That belongs to `EventHub`.
- Tool execution. That belongs to `ToolRuntime` and tool definitions.
- Queue/retry/compaction decisions. Those belong to policies.
- Provider request execution. That belongs to the model/loop adapter layer.

## Design Boundary

`LifecycleHooks` is an internal seam, not a public plugin API.

The current shape intentionally mirrors the useful core of Pi coding-agent's
extension lifecycle, but keeps agent-core smaller:

- Hooks are plain functions grouped by execution node.
- Hooks run in registration order.
- Hook outputs are immutable-style results, not shared mutable runtime objects.
- Transform results are chained so later hooks see earlier changes.
- Blocking hooks short-circuit the hook chain for that execution node.
- Event listeners remain observational; lifecycle hooks are the control plane.

## Hook Nodes

The first version defines these hook nodes:

```text
AgentRuntimeSession.execute(command)
  -> LifecycleRunner.onInput
  -> TurnRunner
     -> LifecycleRunner.beforeRun
     -> LifecycleRunner.beforeContext
     -> AgentLoopAdapter / model loop
        -> ToolRuntime
           -> LifecycleRunner.beforeToolCall
           -> tool.execute
           -> LifecycleRunner.afterToolCall
        -> LifecycleRunner.afterMessage
     -> LifecycleRunner.beforeCompaction
     -> LifecycleRunner.afterRun
```

Current implementation status:

- `onInput`, `beforeRun`, `beforeContext`, `afterMessage`, and `afterRun` are
  wired through `TurnRunner` / `AgentRuntimeSession`.
- `beforeToolCall` and `afterToolCall` are wired through `ToolRuntime`.
- `beforeCompaction` is defined but will only run after compaction policy is
  wired into the run pipeline.

## Result Semantics

### onInput

`onInput` is a serial transform pipeline with an explicit short-circuit action.

```text
currentCommand = original command

for hook in onInput:
  result = hook({ command: currentCommand })

  if result is undefined or continue:
    currentCommand is unchanged
    continue

  if result is transform:
    currentCommand = result.command
    continue

  if result is handled:
    return handled immediately
```

Actions:

- `continue`: keep the current command and run the next hook.
- `transform`: replace the command for downstream hooks and the agent loop.
- `handled`: stop the hook chain and do not send the command to the model.

Use `handled` for runtime-local inputs such as resource reload, local commands,
or future skill commands that complete without an LLM call.

### beforeRun

`beforeRun` executes after input has been accepted and before the run context is
assembled.

It can return:

- Additional internal messages for this run.
- A per-turn `systemPrompt` override.
- Metadata for downstream lifecycle nodes.

The override is temporary. It must not mutate the base `PromptPlan`.

### beforeContext

`beforeContext` executes before an LLM call, after messages have been projected
for the turn.

It can return:

- A replacement `messages` array.
- A per-call `systemPrompt` override.
- Metadata for downstream context processing.

This is the intended node for memory recall, active skill text, temporary
materials, and future context budget handling.

Current `TurnRunner` wiring requires returned `messages` to preserve the
existing conversation prefix. Only messages after that prefix are passed to
`loop.prompt(...)` as the current prompt batch. This prevents lifecycle hooks
from accidentally duplicating persisted history. Full arbitrary context
replacement belongs in the future `ContextAssembler` / deeper loop integration.

### beforeToolCall

`beforeToolCall` executes after the model requests a tool call and before the
tool implementation runs.

It can return:

- `undefined`, `true`, or `{ allow: true }` to continue.
- `false` or `{ allow: false, reason }` to block the call.
- `{ args }` to replace the args seen by later hooks and the tool.

Blocking returns `{ status: "blocked" }` to `ToolRuntime`, and the tool body is
not executed.

### afterToolCall

`afterToolCall` executes after the tool body has produced a standardized
runtime result and before `ToolRuntime` publishes its final event or returns the
result to the loop.

It can rewrite:

- `status`
- `result`
- `error`

This is the intended node for output sanitization, details normalization,
artifact extraction, and future memory candidates.

### afterMessage

`afterMessage` executes when a message is finalized.

It can return a replacement message. Replacements should preserve the original
message role. This hook is for message normalization and extraction work, not
for queue/retry decisions.

### beforeCompaction

`beforeCompaction` executes before conversation compaction.

It can:

- Cancel the compaction.
- Add compaction instructions.
- Pass diagnostic metadata forward.

This hook is defined ahead of the compaction policy implementation so future
work has a stable seam.

### afterRun

`afterRun` is a notification hook after a run has reached a terminal state.

It should be used for cleanup, diagnostics, and non-critical side effects. It
does not rewrite the run result.

## Error Handling

Lifecycle hooks are control-plane code. Hook failures should be visible and
diagnosable.

Current behavior:

- `ToolRuntime` decides how `afterToolCall` failures affect tool status.
- Other lifecycle nodes currently allow errors to propagate to their caller.

Target behavior:

- Hook errors should become standardized runtime failures or diagnostic events.
- Hook errors should not be silently swallowed.
- Non-critical notification hooks may later be isolated so cleanup failures do
  not corrupt already-stable runtime state.

## Relationship To ToolRuntime

`ToolRuntime` is still the tool execution gateway.

It owns:

- policy and approval handling
- tool execution
- tool update wrapping
- ToolRuntime event emission
- normalization of tool outcomes

It no longer owns `beforeToolCall` or `afterToolCall` hook definitions. Those
belong to lifecycle. `ToolRuntime` calls `LifecycleRunner` at the tool execution
nodes.

## Playground

The agent-core playground can print lifecycle hook traces:

```text
/lifecycle on
```

or JSON lines:

```text
/lifecycle json
```

This is the fastest manual way to verify hook ordering while evolving
`TurnRunner`, `ContextAssembler`, `ToolRuntime`, and policies.
