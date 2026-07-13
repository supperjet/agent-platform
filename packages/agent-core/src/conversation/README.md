# Conversation State v1

`agent-core` owns the shape and validation of versioned conversation state. Hosts such as `agent-server` persist `AgentConversationState` as opaque JSON and pass it back into `AgentRuntimeFactory.create(sessionId, state?)` on restore.

## Persisted Contract

New exports use an entry graph payload:

```json
{
  "schemaVersion": 1,
  "modelId": "provider:model",
  "payload": {
    "entries": [],
    "leafId": null
  }
}
```

- `schemaVersion`: state format version. v1 is the only supported version.
- `modelId`: runtime model identity. Restore rejects state saved for a different model.
- `payload.entries`: append-only conversation entries. v1 entries are message entries with `id`, `parentId`, `timestamp`, and `message`.
- `payload.leafId`: the active branch leaf. Projection follows `parentId` links from this entry back to the root to rebuild the active `messages` path.

`payload.messages` is legacy input only. `restoreConversationSnapshot` still accepts it and converts messages into a linear entry graph, but new exports must use `payload.entries` plus `payload.leafId`.

## Runtime Semantics

The runtime keeps the full graph and exposes the active transcript by projection. `messageCount` reports the active transcript length, not necessarily the total number of stored entries once branches exist.

When a prompt appends new messages, each new entry points to the previous active `leafId`; the last appended entry becomes the next `leafId`.

## Runtime Assembly Boundary

`RuntimeAssembler` is a composition layer, not the schema owner. It resolves the runtime model and Agent definition, passes the saved `AgentConversationState` to `ConversationStore.restore(...)`, and returns the restored conversation snapshot to the runtime.

Do not parse `payload.entries`, read `payload.leafId`, or mutate graph structure in `RuntimeAssembler`. Conversation validation, legacy message conversion, graph projection, and compatibility metadata belong in the `conversation/` module.

## Compatibility Metadata

`definitionId` is compatibility metadata produced during restore by the runtime assembly path. It is not currently persisted in the v1 payload. Use it to describe which Agent definition restored the state, not to identify graph entries.

## Server Boundary

`agent-server` must not parse or mutate the conversation graph in v1. It owns session metadata, execution leases, command dispatch, and durable storage; `agent-core` owns conversation validation, projection, export, and restore.

The expected server behavior is:

1. Save `runtime.exportState()` after a successful prompt.
2. Pass the saved `agentState` back into the runtime factory before the next prompt.
3. Keep database schema and public Session APIs independent of graph internals.
