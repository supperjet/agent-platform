import assert from "node:assert/strict";
import test from "node:test";
import { SessionCommandRunner } from "../session/command-runner.js";
import { InMemoryCommandRepository } from "../session/memory/in-memory-command-repository.js";
import { InMemoryCommandSubmissionStore } from "../session/memory/in-memory-command-submission-store.js";
import { InProcessExecutionDispatcher } from "../session/memory/in-process-execution-dispatcher.js";
import { SessionManager, type CommandReceipt, type SessionSnapshot } from "../session/contracts.js";
import { CommandConflictError } from "../session/errors.js";
import { InProcessSessionApplication } from "../session/session-application.js";

test("submits commands and exposes sessions through one application interface", async () => {
  const sessions = new RecordingSessionManager();
  const { application } = createTestApplication(sessions);

  const receipt = await application.submitCommand({
    sessionId: "session-1",
    commandId: "command-1",
    type: "prompt",
    text: "hello"
  });
  await application.close();

  assert.deepEqual(receipt, {
    accepted: true,
    sessionId: "session-1",
    commandId: "command-1",
    type: "prompt"
  });
  assert.deepEqual(sessions.calls, [{ type: "prompt", sessionId: "session-1", text: "hello" }]);
  assert.deepEqual(await application.getSession("session-1"), {
    sessionId: "session-1",
    status: "idle",
    createdAt: "1970-01-01T00:00:00.000Z",
    lastActiveAt: "1970-01-01T00:00:00.000Z",
    messageCount: 0,
    modelId: "test-model"
  });
  assert.deepEqual(await application.getCommand("command-1"), {
    commandId: "command-1",
    sessionId: "session-1",
    type: "prompt",
    text: "hello",
    accepted: true,
    status: "succeeded",
    createdAt: 1000,
    updatedAt: 1000
  });
});

test("accepts a command without waiting for agent execution", async () => {
  let releasePrompt!: () => void;
  const promptGate = new Promise<void>((resolve) => { releasePrompt = resolve; });
  const sessions = new RecordingSessionManager(promptGate);
  const { application } = createTestApplication(sessions);

  const submission = application.submitCommand({
    sessionId: "session-1",
    commandId: "command-1",
    type: "prompt",
    text: "hello"
  });
  const outcome = await Promise.race([
    submission.then(() => "accepted"),
    new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 20))
  ]);
  assert.equal((await application.getCommand("command-1"))?.status, "running");
  releasePrompt();
  await application.close();

  assert.equal(outcome, "accepted");
  assert.equal((await application.getCommand("command-1"))?.status, "succeeded");
});

test("retries an identical command without executing it twice", async () => {
  const sessions = new RecordingSessionManager();
  const { application } = createTestApplication(sessions);
  const command = {
    sessionId: "session-1",
    commandId: "command-1",
    type: "prompt" as const,
    text: "hello"
  };

  const first = await application.submitCommand(command);
  const retry = await application.submitCommand(command);
  await application.close();

  assert.deepEqual(retry, first);
  assert.deepEqual(sessions.calls, [{ type: "prompt", sessionId: "session-1", text: "hello" }]);
});

test("executes only one of two concurrent identical commands", async () => {
  let releasePrompt!: () => void;
  const promptGate = new Promise<void>((resolve) => { releasePrompt = resolve; });
  const sessions = new RecordingSessionManager(promptGate);
  const { application } = createTestApplication(sessions);
  const command = {
    sessionId: "session-1",
    commandId: "command-1",
    type: "prompt" as const,
    text: "hello"
  };

  const first = application.submitCommand(command);
  const retry = application.submitCommand(command);
  const retryReceipt = await retry;
  const firstReceipt = await first;
  releasePrompt();
  await application.close();

  assert.deepEqual(retryReceipt, firstReceipt);
  assert.deepEqual(sessions.calls, [{ type: "prompt", sessionId: "session-1", text: "hello" }]);
});

test("executes prompts for the same session sequentially", async () => {
  let releasePrompt!: () => void;
  const promptGate = new Promise<void>((resolve) => { releasePrompt = resolve; });
  const sessions = new RecordingSessionManager(promptGate);
  const { application } = createTestApplication(sessions);

  await application.submitCommand({
    sessionId: "session-1",
    commandId: "command-1",
    type: "prompt",
    text: "first"
  });
  await application.submitCommand({
    sessionId: "session-1",
    commandId: "command-2",
    type: "prompt",
    text: "second"
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(sessions.calls, [{ type: "prompt", sessionId: "session-1", text: "first" }]);
  releasePrompt();
  await application.close();
  assert.equal(sessions.calls.length, 2);
});

test("executes prompts for different sessions concurrently", async () => {
  let releasePrompts!: () => void;
  const promptGate = new Promise<void>((resolve) => { releasePrompts = resolve; });
  const sessions = new RecordingSessionManager(promptGate);
  const { application } = createTestApplication(sessions);

  await application.submitCommand({
    sessionId: "session-1",
    commandId: "command-1",
    type: "prompt",
    text: "first"
  });
  await application.submitCommand({
    sessionId: "session-2",
    commandId: "command-2",
    type: "prompt",
    text: "second"
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(sessions.calls.length, 2);
  releasePrompts();
  await application.close();
});

test("dispatches control commands while a prompt is running", async () => {
  let releasePrompt!: () => void;
  const promptGate = new Promise<void>((resolve) => { releasePrompt = resolve; });
  const sessions = new RecordingSessionManager(promptGate);
  const { application } = createTestApplication(sessions);

  await application.submitCommand({
    sessionId: "session-1",
    commandId: "prompt-1",
    type: "prompt",
    text: "hello"
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await application.submitCommand({
    sessionId: "session-1",
    commandId: "abort-1",
    type: "abort"
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(sessions.calls, [
    { type: "prompt", sessionId: "session-1", text: "hello" },
    { type: "abort", sessionId: "session-1" }
  ]);
  releasePrompt();
  await application.close();
});

test("rejects reuse of a command id with different content", async () => {
  const sessions = new RecordingSessionManager();
  const { application } = createTestApplication(sessions);
  await application.submitCommand({
    sessionId: "session-1",
    commandId: "command-1",
    type: "prompt",
    text: "hello"
  });

  await assert.rejects(
    application.submitCommand({
      sessionId: "session-1",
      commandId: "command-1",
      type: "prompt",
      text: "different"
    }),
    (error: unknown) => error instanceof CommandConflictError
      && error.code === "COMMAND_CONFLICT"
  );
  await application.close();
  assert.equal(sessions.calls.length, 1);
});

function createTestApplication(sessions: SessionManager) {
  const commands = new InMemoryCommandRepository();
  const submissions = new InMemoryCommandSubmissionStore(commands, () => 1000);
  const runner = new SessionCommandRunner(commands, sessions, { now: () => 1000 });
  const dispatcher = new InProcessExecutionDispatcher(runner);
  const application = new InProcessSessionApplication(sessions, commands, submissions, dispatcher);
  return { application, commands, dispatcher };
}

class RecordingSessionManager extends SessionManager {
  readonly calls: Array<{ type: string; sessionId: string; text?: string }> = [];
  private readonly existingSessions = new Set<string>();

  constructor(private readonly promptGate?: Promise<void>) {
    super();
  }

  async prompt(sessionId: string, text: string) {
    this.calls.push({ type: "prompt", sessionId, text });
    this.existingSessions.add(sessionId);
    await this.promptGate;
    return this.receipt("prompt", sessionId, true);
  }

  steer(sessionId: string, text: string) {
    this.calls.push({ type: "steer", sessionId, text });
    return Promise.resolve(this.receipt("steer", sessionId, this.existingSessions.has(sessionId)));
  }

  followUp(sessionId: string, text: string) {
    this.calls.push({ type: "follow-up", sessionId, text });
    return Promise.resolve(this.receipt("follow-up", sessionId, this.existingSessions.has(sessionId)));
  }

  abort(sessionId: string) {
    this.calls.push({ type: "abort", sessionId });
    return Promise.resolve(this.receipt("abort", sessionId, this.existingSessions.has(sessionId)));
  }

  async snapshot(sessionId: string): Promise<SessionSnapshot | undefined> {
    return this.existingSessions.has(sessionId) ? {
      sessionId,
      status: "idle",
      createdAt: 0,
      lastActiveAt: 0,
      messageCount: 0,
      modelId: "test-model"
    } : undefined;
  }

  private receipt(action: CommandReceipt["action"], sessionId: string, accepted: boolean): CommandReceipt {
    return {
      accepted,
      sessionId,
      action,
      outcome: accepted
        ? { status: "succeeded" }
        : { status: "failed", errorCode: "SESSION_NOT_FOUND", message: "Session not found." }
    };
  }
}
