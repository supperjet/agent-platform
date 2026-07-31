# Context

Owns per-turn context assembly, lifecycle context injection, and context budget
diagnostics.

`ContextAssembler` currently consumes:

- the prompt command
- the base system prompt
- existing conversation messages
- per-turn input metadata from `InputProcessor`

It produces the prompt messages passed to the loop plus a complete context view
for diagnostics. Input metadata is scratch state for the current turn; it is not
written to conversation state by default.

Prompt messages are split into persistence scopes:

- `persistent`: the user's accepted prompt message, which should remain in the
  conversation history.
- `transient`: lifecycle-injected run-local messages, such as active skill text,
  slash-command context, or memory snippets. These messages are visible to the
  model for the current run, then removed from loop history before conversation
  state is exported.

Runtime message events carry the same scope as `messageScope`, allowing clients
to keep debug visibility without treating transient context as transcript.

The first diagnostics surface is `TurnContext.metadata.diagnostics`:

- `budget`: message count, character estimates, conservative token estimates,
  model/input token budget, pressure status, compaction recommendation, and the
  largest message contributors from `ContextBudget`
- `injectedSources`: which extension points injected prompt, message, or
  metadata material
- `persistentPromptMessageCount` and `transientPromptMessageCount`: how the
  prompt messages were scoped for persistence

This keeps context observability available before automatic compaction, memory,
and skill expansion are wired in. `ContextBudget` intentionally estimates token
pressure; provider-specific tokenizer integration can replace the estimator
later without changing the report shape.
