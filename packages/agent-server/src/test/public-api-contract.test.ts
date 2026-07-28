import assert from "node:assert/strict";
import test from "node:test";
import { SessionCommandRunner } from "../session/command-runner.js";
import { DefaultBrowserEventProjector } from "../consumer/browser-events.js";
import { createAgentFastifyServer } from "../consumer/fastify-app.js";
import { InMemoryPublicEventStream } from "../consumer/public-event-stream.js";
import { SessionEventBus } from "../messaging/contracts.js";
import type { AgentNotification, AgentNotificationListener } from "../messaging/events.js";
import { InMemoryCommandRepository } from "../session/memory/in-memory-command-repository.js";
import { InMemoryCommandSubmissionStore } from "../session/memory/in-memory-command-submission-store.js";
import { InProcessExecutionDispatcher } from "../session/memory/in-process-execution-dispatcher.js";
import { SessionManager, type CommandReceipt, type SessionSnapshot } from "../session/contracts.js";
import { InProcessSessionApplication } from "../session/session-application.js";

test("v1 accepts commands through the stable session command endpoint", async () => {
  const sessions = new RecordingSessionManager();
  const events = new SilentEventBus();
  const { application, publicEvents } = createSessionApplication(sessions, events);
  const app = createAgentFastifyServer({
    application,
    publicEvents
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/sessions/session-1/commands",
      payload: { commandId: "command-1", type: "prompt", text: "hello" }
    });
    await application.close();

    assert.equal(response.statusCode, 202);
    assert.deepEqual(response.json(), {
      accepted: true,
      sessionId: "session-1",
      commandId: "command-1",
      type: "prompt"
    });
    assert.deepEqual(sessions.calls, [{ type: "prompt", sessionId: "session-1", text: "hello" }]);
  } finally {
    await app.close();
  }
});

test("v1 exposes projected events in stable public envelopes", async () => {
  const events = new TestEventBus();
  const sessions = new RecordingSessionManager(events);
  const { application, publicEvents } = createSessionApplication(sessions, events);
  const app = createAgentFastifyServer({
    application,
    publicEvents
  });

  try {
    await app.inject({
      method: "POST",
      url: "/api/v1/sessions/session-1/commands",
      payload: { commandId: "command-1", type: "prompt", text: "hello" }
    });
    await application.close();
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/sessions/session-1/events"
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.sessionId, "session-1");
    assert.equal(body.events.length, 1);
    assert.deepEqual({ ...body.events[0], eventId: "<stable>", occurredAt: "<iso>" }, {
      eventId: "<stable>",
      sequence: 1,
      sessionId: "session-1",
      commandId: "command-1",
      type: "run_started",
      occurredAt: "<iso>",
      payload: {}
    });
    assert.equal(typeof body.events[0].eventId, "string");
    assert.equal(Number.isNaN(Date.parse(body.events[0].occurredAt)), false);
  } finally {
    await app.close();
  }
});

test("v1 publishes session discovery, validation errors, and its OpenAPI surface", async () => {
  const sessions = new RecordingSessionManager();
  const events = new SilentEventBus();
  const { application, publicEvents } = createSessionApplication(sessions, events);
  const app = createAgentFastifyServer({
    application,
    publicEvents
  });

  try {
    const invalid = await app.inject({
      method: "POST",
      url: "/api/v1/sessions/session-1/commands",
      payload: { commandId: "command-1", type: "prompt" }
    });
    assert.equal(invalid.statusCode, 400);
    assert.deepEqual(invalid.json(), {
      error: { code: "INVALID_COMMAND", message: "Command type \"prompt\" requires text." }
    });

    await app.inject({
      method: "POST",
      url: "/api/v1/sessions/session-1/commands",
      payload: { commandId: "command-2", type: "prompt", text: "hello" }
    });
    await application.close();
    const session = await app.inject({ method: "GET", url: "/api/v1/sessions/session-1" });
    assert.equal(session.statusCode, 200);
    assert.deepEqual(session.json(), {
      sessionId: "session-1",
      status: "idle",
      createdAt: "1970-01-01T00:00:00.000Z",
      lastActiveAt: "1970-01-01T00:00:00.000Z",
      messageCount: 0,
      modelId: "test-model"
    });

    const openApi = await app.inject({ method: "GET", url: "/api/v1/openapi.json" });
    assert.equal(openApi.statusCode, 200);
    assert.equal(openApi.json().openapi, "3.1.0");
    assert.ok(openApi.json().paths["/api/v1/sessions/{sessionId}/commands"]);
  } finally {
    await app.close();
  }
});

test("v1 exposes unresolved Session commit failures through session discovery", async () => {
  const sessions = new RecordingSessionManager(undefined, undefined, "commit_failed");
  const events = new SilentEventBus();
  const { application, publicEvents } = createSessionApplication(sessions, events);
  const app = createAgentFastifyServer({
    application,
    publicEvents
  });

  try {
    await app.inject({
      method: "POST",
      url: "/api/v1/sessions/session-1/commands",
      payload: { commandId: "command-1", type: "prompt", text: "hello" }
    });
    await application.close();

    const session = await app.inject({ method: "GET", url: "/api/v1/sessions/session-1" });

    assert.equal(session.statusCode, 200);
    assert.equal(session.json().status, "commit_failed");
  } finally {
    await app.close();
  }
});

test("v1 reports a command id reused with different content as a conflict", async () => {
  const sessions = new RecordingSessionManager();
  const events = new SilentEventBus();
  const { application, publicEvents } = createSessionApplication(sessions, events);
  const app = createAgentFastifyServer({
    application,
    publicEvents
  });

  try {
    await app.inject({
      method: "POST",
      url: "/api/v1/sessions/session-1/commands",
      payload: { commandId: "command-1", type: "prompt", text: "hello" }
    });
    const conflict = await app.inject({
      method: "POST",
      url: "/api/v1/sessions/session-1/commands",
      payload: { commandId: "command-1", type: "prompt", text: "different" }
    });
    await application.close();

    assert.equal(conflict.statusCode, 409);
    assert.deepEqual(conflict.json(), {
      error: {
        code: "COMMAND_CONFLICT",
        message: "Command \"command-1\" already exists with different content."
      }
    });
    assert.equal(sessions.calls.length, 1);
  } finally {
    await app.close();
  }
});

test("v1 keeps command correlation when a queued prompt starts later", async () => {
  let releasePrompt!: () => void;
  const promptGate = new Promise<void>((resolve) => { releasePrompt = resolve; });
  const events = new TestEventBus();
  const sessions = new RecordingSessionManager(events, promptGate);
  const { application, publicEvents } = createSessionApplication(sessions, events);
  const app = createAgentFastifyServer({ application, publicEvents });

  try {
    await app.inject({
      method: "POST",
      url: "/api/v1/sessions/session-1/commands",
      payload: { commandId: "command-1", type: "prompt", text: "first" }
    });
    await app.inject({
      method: "POST",
      url: "/api/v1/sessions/session-1/commands",
      payload: { commandId: "command-2", type: "prompt", text: "second" }
    });
    releasePrompt();
    await application.close();
    const history = await app.inject({
      method: "GET",
      url: "/api/v1/sessions/session-1/events"
    });

    assert.deepEqual(
      history.json().events.map((event: { commandId: string }) => event.commandId),
      ["command-1", "command-2"]
    );
  } finally {
    await app.close();
  }
});

function createSessionApplication(sessions: SessionManager, events: SessionEventBus) {
  const commands = new InMemoryCommandRepository();
  const submissions = new InMemoryCommandSubmissionStore(commands);
  const publicEvents = new InMemoryPublicEventStream(new DefaultBrowserEventProjector());
  events.subscribeAll((event) => publicEvents.accept(event));
  const runner = new SessionCommandRunner(commands, sessions, {
    runInContext: (command, operation) => publicEvents.run(
      command.sessionId,
      command.commandId,
      operation
    )
  });
  const dispatcher = new InProcessExecutionDispatcher(runner);
  const application = new InProcessSessionApplication(sessions, commands, submissions, dispatcher);
  return { application, publicEvents };
}

class RecordingSessionManager extends SessionManager {
  readonly calls: Array<{ type: string; sessionId: string; text?: string }> = [];
  private readonly existingSessions = new Set<string>();

  constructor(
    private readonly events?: SessionEventBus,
    private readonly promptGate?: Promise<void>,
    private readonly snapshotStatus: SessionSnapshot["status"] = "idle"
  ) {
    super();
  }

  async prompt(sessionId: string, text: string) {
    this.calls.push({ type: "prompt", sessionId, text });
    this.existingSessions.add(sessionId);
    this.events?.publish({ type: "run_started", sessionId });
    await this.promptGate;
    return this.receipt("prompt", sessionId);
  }

  steer(sessionId: string, text: string) {
    this.calls.push({ type: "steer", sessionId, text });
    return Promise.resolve(this.receipt("steer", sessionId));
  }

  followUp(sessionId: string, text: string) {
    this.calls.push({ type: "follow-up", sessionId, text });
    return Promise.resolve(this.receipt("follow-up", sessionId));
  }

  abort(sessionId: string) {
    this.calls.push({ type: "abort", sessionId });
    return Promise.resolve(this.receipt("abort", sessionId));
  }

  async snapshot(sessionId: string): Promise<SessionSnapshot | undefined> {
    return this.existingSessions.has(sessionId) ? {
      sessionId,
      status: this.snapshotStatus,
      createdAt: 0,
      lastActiveAt: 0,
      messageCount: 0,
      modelId: "test-model"
    } : undefined;
  }

  private receipt(action: CommandReceipt["action"], sessionId: string): CommandReceipt {
    return { accepted: true, sessionId, action, outcome: { status: "succeeded" } };
  }
}

class SilentEventBus extends SessionEventBus {
  publish(_event: AgentNotification) {}
  subscribe(_sessionId: string, _listener: AgentNotificationListener) { return () => {}; }
  subscribeAll(_listener: AgentNotificationListener) { return () => {}; }
}

class TestEventBus extends SessionEventBus {
  private readonly sessionListeners = new Map<string, Set<AgentNotificationListener>>();
  private readonly allListeners = new Set<AgentNotificationListener>();

  publish(event: AgentNotification) {
    for (const listener of this.sessionListeners.get(event.sessionId) ?? []) listener(event);
    for (const listener of this.allListeners) listener(event);
  }

  subscribe(sessionId: string, listener: AgentNotificationListener) {
    const listeners = this.sessionListeners.get(sessionId) ?? new Set();
    listeners.add(listener);
    this.sessionListeners.set(sessionId, listeners);
    return () => listeners.delete(listener);
  }

  subscribeAll(listener: AgentNotificationListener) {
    this.allListeners.add(listener);
    return () => this.allListeners.delete(listener);
  }
}
