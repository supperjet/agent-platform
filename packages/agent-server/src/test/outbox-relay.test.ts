import assert from "node:assert/strict";
import test from "node:test";
import {
  CommandRepository,
  ExecutionDispatcher,
  OutboxStore,
  type CommandRecord,
  type CreateCommandResult,
  type DispatchCommand,
  type ExecutionLogEntry,
  type ExecutionLogLevel,
  type OutboxClaim
} from "../session/contracts.js";
import { OutboxRelay } from "../session/outbox-relay.js";

const command: CommandRecord = {
  commandId: "command-1",
  sessionId: "session-1",
  type: "prompt",
  text: "hello",
  accepted: true,
  status: "queued",
  createdAt: 1,
  updatedAt: 1
};

test("claims an outbox event, reloads its command, and marks it published", async () => {
  const outbox = new FakeOutboxStore([claim()]);
  const dispatcher = new RecordingDispatcher();
  const logger = new RecordingLogger();
  const relay = new OutboxRelay(outbox, new FakeCommandRepository(command), dispatcher, {
    pollIntervalMs: 10_000,
    now: () => 100,
    logger
  });

  relay.start();
  await waitFor(() => outbox.published.length === 1);
  await relay.close();

  assert.deepEqual(dispatcher.enqueued, [command]);
  assert.deepEqual(outbox.published, [{ claim: claim(), publishedAt: 100 }]);
  assert.equal(outbox.rescheduled.length, 0);
  assert.deepEqual(logger.entries, [{
    level: "info",
    event: "outbox.command.published",
    commandId: "command-1",
    sessionId: "session-1",
    commandType: "prompt",
    attempt: 1
  }]);
});

test("reschedules delivery with exponential backoff when enqueue fails", async () => {
  const outbox = new FakeOutboxStore([claim({ attempts: 3 })]);
  const errors: unknown[] = [];
  const dispatcher = new RecordingDispatcher(new Error("queue unavailable"));
  const relay = new OutboxRelay(outbox, new FakeCommandRepository(command), dispatcher, {
    pollIntervalMs: 10_000,
    retryDelayMs: 10,
    maxRetryDelayMs: 1_000,
    now: () => 100,
    onError: (error) => errors.push(error)
  });

  relay.start();
  await waitFor(() => outbox.rescheduled.length === 1);
  await relay.close();

  assert.deepEqual(outbox.rescheduled, [{
    claim: claim({ attempts: 3 }),
    error: "queue unavailable",
    availableAt: 140
  }]);
  assert.equal(errors.length, 1);
});

test("wake interrupts the idle polling delay", async () => {
  const outbox = new FakeOutboxStore([]);
  const relay = new OutboxRelay(
    outbox,
    new FakeCommandRepository(command),
    new RecordingDispatcher(),
    { pollIntervalMs: 10_000 }
  );

  relay.start();
  await waitFor(() => outbox.claimCalls === 1);
  outbox.addClaim(claim());
  relay.wake();
  await waitFor(() => outbox.published.length === 1);
  await relay.close();

  assert.equal(outbox.claimCalls >= 2, true);
});

test("publishes an old outbox without re-enqueueing a completed command", async () => {
  const outbox = new FakeOutboxStore([claim()]);
  const dispatcher = new RecordingDispatcher();
  const relay = new OutboxRelay(
    outbox,
    new FakeCommandRepository({ ...command, status: "succeeded" }),
    dispatcher,
    { pollIntervalMs: 10_000 }
  );

  relay.start();
  await waitFor(() => outbox.published.length === 1);
  await relay.close();

  assert.deepEqual(dispatcher.enqueued, []);
});

class FakeOutboxStore extends OutboxStore {
  claimCalls = 0;
  readonly published: Array<{ claim: OutboxClaim; publishedAt: number }> = [];
  readonly rescheduled: Array<{ claim: OutboxClaim; error: string; availableAt: number }> = [];

  constructor(private readonly claims: OutboxClaim[]) {
    super();
  }

  claimNext() {
    this.claimCalls += 1;
    return Promise.resolve(this.claims.shift());
  }

  addClaim(value: OutboxClaim) {
    this.claims.push(value);
  }

  markPublished(value: OutboxClaim, publishedAt: number) {
    this.published.push({ claim: value, publishedAt });
    return Promise.resolve();
  }

  reschedule(value: OutboxClaim, error: string, availableAt: number) {
    this.rescheduled.push({ claim: value, error, availableAt });
    return Promise.resolve();
  }
}

class FakeCommandRepository extends CommandRepository {
  constructor(private readonly command: CommandRecord) {
    super();
  }

  async createIfAbsent(): Promise<CreateCommandResult> {
    throw new Error("Not used by this test.");
  }

  async save() {
    throw new Error("Not used by this test.");
  }

  find(commandId: string) {
    return Promise.resolve(commandId === this.command.commandId ? this.command : undefined);
  }
}

class RecordingDispatcher extends ExecutionDispatcher {
  readonly enqueued: DispatchCommand[] = [];

  constructor(private readonly failure?: Error) {
    super();
  }

  enqueue(value: DispatchCommand) {
    if (this.failure) return Promise.reject(this.failure);
    this.enqueued.push(value);
    return Promise.resolve();
  }

  ready() {
    return Promise.resolve();
  }

  close() {
    return Promise.resolve();
  }
}

class RecordingLogger {
  readonly entries: Array<ExecutionLogEntry & { level: ExecutionLogLevel }> = [];

  log(level: ExecutionLogLevel, entry: ExecutionLogEntry) {
    this.entries.push({ level, ...entry });
  }
}

function claim(overrides: Partial<OutboxClaim> = {}): OutboxClaim {
  return {
    eventId: "event-1",
    commandId: "command-1",
    leaseId: "lease-1",
    attempts: 1,
    ...overrides
  };
}

async function waitFor(condition: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for relay.");
}
