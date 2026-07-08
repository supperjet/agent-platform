import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Queue } from "bullmq";
import {
  CommandRunner,
  type CommandType,
  type ExecutionLogEntry,
  type ExecutionLogLevel
} from "../session/contracts.js";
import {
  BullMqExecutionDispatcher,
  redisOptionsFromUrl
} from "../session/redis/bullmq-execution-dispatcher.js";
import { BullMqCommandWorker } from "../session/redis/bullmq-command-worker.js";

const redisUrl = process.env.REDIS_INTEGRATION_URL;

test("enqueues and executes a command only once for a stable commandId", {
  skip: redisUrl ? false : "REDIS_INTEGRATION_URL is not configured."
}, async () => {
  const queueName = `commands-${randomUUID()}`;
  const prefix = `agent-platform-test-${randomUUID()}`;
  const runner = new RecordingRunner();
  const logger = new RecordingLogger();
  const { dispatcher, worker } = createQueueAndWorker(queueName, prefix, runner, { logger });

  try {
    await Promise.all([dispatcher.ready(), worker.ready()]);
    const command = {
      commandId: "session:command:1",
      sessionId: "session-1",
      type: "prompt" as const
    };
    await dispatcher.enqueue(command);
    await waitFor(() => runner.calls.length === 1);
    await waitFor(() => logger.events.includes("bullmq.job.completed"));
    await dispatcher.enqueue(command);
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.deepEqual(runner.calls, ["session:command:1"]);
    assert.equal(logger.events.includes("bullmq.job.queued"), true);
    assert.equal(logger.entries.every((entry) => entry.commandId === "session:command:1"), true);
    assert.equal(logger.entries.some((entry) => entry.jobId?.startsWith("command-")), true);
  } finally {
    await dispatcher.close();
    await worker.close();
    await cleanQueue(queueName, prefix);
  }
});

test("retries a command when the Runner fails", {
  skip: redisUrl ? false : "REDIS_INTEGRATION_URL is not configured."
}, async () => {
  const queueName = `commands-${randomUUID()}`;
  const prefix = `agent-platform-test-${randomUUID()}`;
  const runner = new RecordingRunner(1);
  const { dispatcher, worker } = createQueueAndWorker(queueName, prefix, runner, { attempts: 2 });

  try {
    await Promise.all([dispatcher.ready(), worker.ready()]);
    await dispatcher.enqueue({
      commandId: "retry-command",
      sessionId: "session-1",
      type: "prompt"
    });
    await waitFor(() => runner.calls.length === 2);

    assert.deepEqual(runner.calls, ["retry-command", "retry-command"]);
  } finally {
    await dispatcher.close();
    await worker.close();
    await cleanQueue(queueName, prefix);
  }
});

test("serializes prompts from the same session", {
  skip: redisUrl ? false : "REDIS_INTEGRATION_URL is not configured."
}, async () => {
  const queueName = `commands-${randomUUID()}`;
  const prefix = `agent-platform-test-${randomUUID()}`;
  const runner = new SessionConcurrencyRunner();
  const { dispatcher, worker } = createQueueAndWorker(queueName, prefix, runner, { concurrency: 4 });

  try {
    await Promise.all([dispatcher.ready(), worker.ready()]);
    await Promise.all([
      dispatcher.enqueue(prompt("command-1")),
      dispatcher.enqueue(prompt("command-2"))
    ]);
    await waitFor(() => runner.calls === 2);

    assert.equal(runner.maximumActive, 1);
  } finally {
    await dispatcher.close();
    await worker.close();
    await cleanQueue(queueName, prefix);
  }
});

function createQueueAndWorker(
  queueName: string,
  prefix: string,
  runner: CommandRunner,
  overrides: { attempts?: number; concurrency?: number; logger?: RecordingLogger } = {}
) {
  const options = {
    redisUrl: redisUrl!,
    queueName,
    prefix,
    attempts: overrides.attempts ?? 1,
    concurrency: overrides.concurrency ?? 2,
    retryDelayMs: 10,
    ...(overrides.logger ? { logger: overrides.logger } : {})
  };
  return {
    dispatcher: new BullMqExecutionDispatcher(options),
    worker: new BullMqCommandWorker(runner, options)
  };
}

function prompt(commandId: string) {
  return { commandId, sessionId: "session-1", type: "prompt" as CommandType };
}

class RecordingRunner extends CommandRunner {
  readonly calls: string[] = [];

  constructor(private failuresRemaining = 0) {
    super();
  }

  async executeById(commandId: string) {
    this.calls.push(commandId);
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error("temporary failure");
    }
  }
}

class SessionConcurrencyRunner extends CommandRunner {
  calls = 0;
  maximumActive = 0;
  private active = 0;

  async executeById() {
    this.calls += 1;
    this.active += 1;
    this.maximumActive = Math.max(this.maximumActive, this.active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    this.active -= 1;
  }
}

class RecordingLogger {
  readonly entries: Array<ExecutionLogEntry & { level: ExecutionLogLevel }> = [];

  get events() {
    return this.entries.map((entry) => entry.event);
  }

  log(level: ExecutionLogLevel, entry: ExecutionLogEntry) {
    this.entries.push({ level, ...entry });
  }
}

async function cleanQueue(queueName: string, prefix: string) {
  const queue = new Queue(queueName, {
    prefix,
    connection: redisOptionsFromUrl(redisUrl!)
  });
  try {
    await queue.obliterate({ force: true });
  } finally {
    await queue.close();
  }
}

async function waitFor(condition: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for BullMQ.");
}
