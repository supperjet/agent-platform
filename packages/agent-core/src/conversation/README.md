# Conversation State v2

`agent-core` owns the shape and validation of versioned conversation state. Hosts such as `agent-server` persist `AgentConversationState` JSON and pass it back into `AgentRuntimeFactory.create(sessionId, state?)` on restore.

中文说明：conversation 模块只负责“可恢复对话状态”的结构、校验和投影，不负责
数据库、文件或 session lease。宿主保存的是 v2 entry graph；runtime 恢复时，
conversation 模块会从 `leafId` 回溯 active path，并且只把 `kind: "message"` 的
entry 投影成模型可见 messages。

## Persisted Contract

Exports use an entry graph payload:

```json
{
  "schemaVersion": 2,
  "modelId": "provider:model",
  "payload": {
    "entries": [],
    "leafId": null
  }
}
```

- `schemaVersion`: state format version. v2 is the only supported version.
- `modelId`: runtime model identity. Restore rejects state saved for a different model.
- `payload.entries`: append-only conversation entries. v2 entries use `id`, `parentId`, `kind`, `createdAt`, and `payload`.
- `payload.leafId`: the active branch leaf. Projection follows `parentId` links from this entry back to the root to rebuild the active `messages` path.

`payload.messages` and legacy `type/timestamp/message` entries are not supported.

中文说明：旧的 `{ messages }` payload 已经被移除。所有持久化状态都必须进入
`payload.entries`，并使用 `kind/createdAt/payload` 的 v2 entry 结构。

## Runtime Semantics

The runtime keeps the full graph and exposes the active transcript by projection. `messageCount` reports the active transcript length, not necessarily the total number of stored entries once branches exist.

When a prompt appends new messages, each new entry points to the previous active `leafId`; the last appended entry becomes the next `leafId`.

## Runtime Assembly Boundary

`RuntimeAssembler` is a composition layer, not the schema owner. It resolves the runtime model and Agent definition, passes the saved `AgentConversationState` to `ConversationStore.restore(...)`, and returns the restored conversation snapshot to the runtime.

Do not parse `payload.entries`, read `payload.leafId`, or mutate graph structure in `RuntimeAssembler`. Conversation validation, graph projection, and compatibility metadata belong in the `conversation/` module.

## Compatibility Metadata

`definitionId` is compatibility metadata produced during restore by the runtime assembly path. It is not currently persisted in the v2 payload. Use it to describe which Agent definition restored the state, not to identify graph entries.

## Server Boundary

`agent-server` must not mutate the conversation graph. It owns session metadata, execution leases, command dispatch, and durable storage; `agent-core` owns conversation validation, projection, export, and restore.

The expected server behavior is:

1. Save `runtime.exportState()` after a successful prompt.
2. Pass the saved `agentState` back into the runtime factory before the next prompt.
3. Keep database schema and public Session APIs independent of graph internals.
