# Domain Glossary

## Session

A continuous Agent conversation and execution scope identified by `sessionId`. A Session can receive many Commands over its lifetime.

## Agent Conversation State

The versioned, minimal working state required by Agent Core to resume a Session's conversation. It may include messages and tool interactions, but it is not a permanent execution history or cross-Session memory; Server stores it as an opaque value.

## Agent Execution

One invocation of Agent Core for a Command using a supplied Agent Conversation State, producing an outcome, internal events, and an updated state.

## Command

A client-identified request to act within one Session. A Command is identified by `commandId` and has one of four kinds: prompt, steer, follow-up, or abort.

Command acceptance means the server has accepted responsibility for the Command. It does not mean execution has completed successfully.

## Command status

The lifecycle of a Command: accepted, queued, running, succeeded, failed, or cancelled.

The current durable submission path creates a Command directly in `queued`. `accepted` and `cancelled` are reserved statuses without current transitions. A Runner exception temporarily records `failed` and lets BullMQ retry the same Command, which moves it back to `running`; an Agent business failure records `failed` but completes the Job without retrying the Prompt.

## Command retry

A repeated submission with the same `commandId`, Session, kind, and text. A Command retry refers to the original Command and must not execute it again.

Reusing a `commandId` with a different Session, kind, or text is a Command conflict, not a retry.

## Session status

The lifecycle of a Session: idle, running, failed, or closed.

The first Prompt creates a Session in `running`. A successful Prompt saves Agent Conversation State and returns it to `idle`; an Agent or Runtime failure moves it to `failed`. A later Prompt can acquire a lease from either `idle` or `failed`. `closed` is reserved because no public close action exists yet.

## Public Event stream

Worker Runtime events are correlated with a Command and appended to a bounded Redis Stream. Server instances replay the retained window, project browser-safe Public Events, and then tail new entries for SSE delivery. This stream is recoverable within its retention window but is not a permanent audit log or a browser-delivery acknowledgement.
