import { Worker, type Job } from "bullmq";
import type { CommandRunner, ExecutionLogger } from "../contracts.js";
import {
  DEFAULT_QUEUE_NAME,
  type CommandJob,
  isCommandType,
  redisOptionsFromUrl
} from "./bullmq-execution-dispatcher.js";

export type BullMqCommandWorkerOptions = {
  redisUrl: string;
  queueName?: string;
  prefix?: string;
  concurrency?: number;
  onError?: (error: unknown) => void;
  logger?: ExecutionLogger;
};

/** BullMQ consumer owned by the Worker process; it never creates or publishes Queue jobs. */
export class BullMqCommandWorker {
  private readonly worker: Worker<CommandJob>;
  private readonly promptExecutions = new Map<string, Promise<void>>();
  private readonly onError: (error: unknown) => void;
  private readonly logger: ExecutionLogger;
  private closePromise: Promise<void> | undefined;

  constructor(
    private readonly commandRunner: CommandRunner,
    options: BullMqCommandWorkerOptions
  ) {
    const connection = redisOptionsFromUrl(options.redisUrl);
    this.onError = options.onError ?? (() => {});
    this.logger = options.logger ?? { log() {} };
    this.worker = new Worker<CommandJob>(
      options.queueName ?? DEFAULT_QUEUE_NAME,
      (job) => this.execute(job),
      {
        prefix: options.prefix ?? "agent-platform",
        concurrency: positive(options.concurrency ?? 4, "concurrency"),
        connection: { ...connection, maxRetriesPerRequest: null }
      }
    );
    this.worker.on("error", (error) => this.logInfrastructureError(error));
    this.worker.on("active", (job) => this.logJob("info", "bullmq.job.started", job));
    this.worker.on("completed", (job) => this.logJob("info", "bullmq.job.completed", job));
    this.worker.on("failed", (job, error) => {
      if (job) this.logJob("error", "bullmq.job.failed", job, error);
      this.onError(error);
    });
  }

  async ready() {
    await this.worker.waitUntilReady();
  }

  close() {
    this.closePromise ??= this.worker.close();
    return this.closePromise;
  }

  private execute(job: Job<CommandJob>) {
    const command = readCommandJob(job);
    if (command.type !== "prompt") return this.commandRunner.executeById(command.commandId);
    return this.executePromptSerially(command.sessionId, command.commandId);
  }

  private async executePromptSerially(sessionId: string, commandId: string) {
    const previous = this.promptExecutions.get(sessionId) ?? Promise.resolve();
    const execution = previous.catch(() => {}).then(() => this.commandRunner.executeById(commandId));
    this.promptExecutions.set(sessionId, execution);
    try {
      await execution;
    } finally {
      if (this.promptExecutions.get(sessionId) === execution) this.promptExecutions.delete(sessionId);
    }
  }

  private logJob(
    level: "info" | "error",
    event: string,
    job: Job<CommandJob>,
    error?: unknown
  ) {
    this.logger.log(level, {
      event,
      commandId: job.data.commandId,
      sessionId: job.data.sessionId,
      commandType: job.data.type,
      ...(job.id === undefined ? {} : { jobId: job.id }),
      attempt: job.attemptsMade + (event === "bullmq.job.started" ? 1 : 0),
      ...(error === undefined ? {} : { error })
    });
  }

  private logInfrastructureError(error: unknown) {
    this.logger.log("error", { event: "bullmq.worker.error", error });
    this.onError(error);
  }
}

function readCommandJob(job: Job<CommandJob>): CommandJob {
  const { commandId, sessionId, type } = job.data;
  if (!commandId || !sessionId || !isCommandType(type)) {
    throw new Error(`BullMQ job "${job.id}" has invalid command data.`);
  }
  return { commandId, sessionId, type };
}

function positive(value: number, name: string) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  return value;
}
