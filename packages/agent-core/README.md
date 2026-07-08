# agent-core

`agent-core` owns Agent execution: model integration, tools, internal events and versioned conversation state. It has no Fastify, MySQL, Redis, BullMQ or browser dependency.

The primary interface is `AgentRuntimeFactory.create(sessionId, state?)`. A runtime executes Prompt/control commands, emits internal events, and exports an opaque `AgentConversationState` that a caller can persist and later restore.

Run its independent verification without starting `agent-server`:

```bash
npm test --workspace @agent-platform/agent-core
```

The tests use a Faux Provider and cover a real Tool-using Agent run plus conversation export/restore.

Current source layout:

```text
src/
├── contracts.ts
├── runtime/   # Pi runtime, runtime messages and conversation state
├── models/    # Provider model catalog and metadata
├── tools/     # Agent tools
├── test/      # All agent-core tests
└── index.ts   # Public exports
```

Capability directories such as `memory/` and `mcp/` are added only when they contain a real interface and implementation.
