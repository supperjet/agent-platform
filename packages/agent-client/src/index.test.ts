import assert from "node:assert/strict";
import test from "node:test";
import { createAgentConsoleState, reduceConsoleEvent } from "./index.js";

test("agent events build the conversation while preserving event history", () => {
  const initial = createAgentConsoleState("session-1");
  const running = reduceConsoleEvent(initial, {
    type: "run_started",
    sessionId: "session-1"
  });
  const started = reduceConsoleEvent(running, {
    type: "message_started",
    sessionId: "session-1",
    messageId: "message-1",
    role: "assistant",
    text: ""
  });
  const streamed = reduceConsoleEvent(started, {
    type: "assistant_delta",
    sessionId: "session-1",
    messageId: "message-1",
    delta: "hello"
  });

  assert.equal(streamed.isRunning, true);
  assert.equal(streamed.messages[0]?.text, "hello");
  assert.equal(streamed.events.length, 3);
});

test("events from another session are ignored", () => {
  const state = createAgentConsoleState("session-1");
  const next = reduceConsoleEvent(state, { type: "run_started", sessionId: "session-2" });
  assert.strictEqual(next, state);
});

test("a failed run stops loading and removes its empty assistant placeholder", () => {
  const initial = createAgentConsoleState("session-1");
  const running = reduceConsoleEvent(initial, { type: "run_started", sessionId: "session-1" });
  const started = reduceConsoleEvent(running, {
    type: "message_started",
    sessionId: "session-1",
    messageId: "message-1",
    role: "assistant",
    text: ""
  });
  const failed = reduceConsoleEvent(started, {
    type: "run_failed",
    sessionId: "session-1",
    errorCode: "AGENT_RUN_FAILED",
    message: "Provider unavailable"
  });

  assert.equal(failed.isRunning, false);
  assert.equal(failed.messages.length, 0);
  assert.equal(failed.events.at(-1)?.type, "run_failed");
});

test("default browser fetch keeps the global receiver", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = function (this: unknown) {
    if (this !== globalThis) throw new TypeError("Illegal invocation");
    return Promise.resolve(new Response(JSON.stringify({
      accepted: true,
      sessionId: "session-1",
      commandId: "command-1",
      type: "prompt"
    }), { status: 202, headers: { "content-type": "application/json" } }));
  };

  try {
    const { AgentServerClient } = await import("./index.js");
    const receipt = await new AgentServerClient().send("session-1", "prompt", "hello");
    assert.equal(receipt.accepted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("client uses the frozen v1 command and event contracts", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, ...(init === undefined ? {} : { init }) });
    if (url.endsWith("/events")) {
      return new Response(JSON.stringify({ events: [{
        eventId: "event-1",
        sequence: 1,
        sessionId: "session/1",
        commandId: "command-1",
        type: "run_started",
        occurredAt: "2026-01-01T00:00:00.000Z",
        payload: {}
      }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      accepted: true,
      sessionId: "session/1",
      commandId: "command-1",
      type: "prompt"
    }), { status: 202, headers: { "content-type": "application/json" } });
  };
  const { AgentServerClient } = await import("./index.js");
  const client = new AgentServerClient("https://agent.test", fetcher as typeof fetch);

  await client.send("session/1", "prompt", "hello");
  const history = await client.history("session/1");

  assert.equal(requests[0]?.url, "https://agent.test/api/v1/sessions/session%2F1/commands");
  const command = JSON.parse(String(requests[0]?.init?.body));
  assert.equal(command.type, "prompt");
  assert.equal(command.text, "hello");
  assert.equal(typeof command.commandId, "string");
  assert.equal(requests[1]?.url, "https://agent.test/api/v1/sessions/session%2F1/events");
  assert.deepEqual(history, [{
    type: "run_started",
    sessionId: "session/1",
    receivedAt: "2026-01-01T00:00:00.000Z"
  }]);
  assert.equal(client.eventStreamUrl("session/1"), "https://agent.test/api/v1/sessions/session%2F1/event-stream");
});
