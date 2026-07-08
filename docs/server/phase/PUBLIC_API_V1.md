# Agent Server Public API v1

This document freezes the browser-facing contract used by `agent-client`. Internal server modules may be replaced without changing these observable shapes.

## Endpoints

- `POST /api/v1/sessions/:sessionId/commands` accepts `{ commandId, type, text? }`. `type` is `prompt`, `steer`, `follow-up`, or `abort`; `text` is required except for `abort`.
- `GET /api/v1/sessions/:sessionId` returns the current public Session summary.
- `GET /api/v1/sessions/:sessionId/events` returns `{ sessionId, events }`.
- `GET /api/v1/sessions/:sessionId/event-stream` emits named SSE events. Each agent event includes an SSE `id` equal to its `eventId`; `connected` is a transport control event.
- `GET /api/v1/openapi.json` returns the machine-readable contract.

Every public agent event has this envelope:

```json
{
  "eventId": "uuid",
  "sequence": 1,
  "sessionId": "session-1",
  "commandId": "command-1",
  "type": "run_started",
  "occurredAt": "2026-07-02T00:00:00.000Z",
  "payload": {}
}
```

Errors use `{ "error": { "code": "STABLE_CODE", "message": "Human readable message" } }`. Current stable codes are `INVALID_REQUEST`, `INVALID_COMMAND`, `COMMAND_CONFLICT`, `SESSION_NOT_FOUND`, `SESSION_BUSY`, and `INTERNAL_ERROR`.

## Compatibility policy

Fields documented here are additive-only within v1. Removing or renaming a field, changing its meaning, or changing an endpoint requires a new API version. Internal notifications are projected and filtered before entering this contract.

The legacy `/api/agent/*` compatibility endpoints have been removed. Clients must use the v1 session endpoints.

`202 Accepted` is the frozen submission response. The current in-process Dispatcher returns after an accepted Command is queued and executes it in the background; its queue is memory-only and is lost if the process terminates unexpectedly.
