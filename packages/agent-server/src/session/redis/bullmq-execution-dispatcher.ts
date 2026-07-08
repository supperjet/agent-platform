import { createHash } from "node:crypto";
import { Queue, type RedisOptions } from "bullmq";
import {
  ExecutionDispatcher,
  type CommandType,
  type DispatchCommand,
  type ExecutionLogger
} from "../contracts.js";

export const DEFAULT_QUEUE_NAME = "agent-commands-v1";
export const EXECUTE_COMMAND_JOB = "execute-command";

export type CommandJob = {
  commandId: string;
  sessionId: string;
  type: CommandType;
};

export type BullMqExecutionDispatcherOptions = {
  redisUrl: string;
  queueName?: string;
  prefix?: string;
  attempts?: number;
  retryDelayMs?: number;
  onError?: (error: unknown) => void;
  logger?: ExecutionLogger;
};

export class BullMqExecutionDispatcher extends ExecutionDispatcher {
  private readonly queue: Queue<CommandJob>;
  private readonly onError: (error: unknown) => void;
  private readonly logger: ExecutionLogger;
  private closePromise: Promise<void> | undefined;

  constructor(options: BullMqExecutionDispatcherOptions) {
    super();
    const connection = redisOptionsFromUrl(options.redisUrl);
    const queueName = options.queueName ?? DEFAULT_QUEUE_NAME;
    const prefix = options.prefix ?? "agent-platform";
    const attempts = positive(options.attempts ?? 3, "attempts");
    const retryDelayMs = positive(options.retryDelayMs ?? 1_000, "retryDelayMs");
    this.onError = options.onError ?? (() => {});
    this.logger = options.logger ?? { log() {} };

    this.queue = new Queue<CommandJob>(queueName, {
      prefix,
      connection: {
        ...connection,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1
      },
      defaultJobOptions: {
        attempts,
        backoff: { type: "exponential", delay: retryDelayMs },
        removeOnComplete: { age: 86_400, count: 10_000 },
        removeOnFail: { age: 604_800, count: 10_000 }
      }
    });
    this.queue.on("error", (error) => this.logInfrastructureError("bullmq.queue.error", error));
  }

  async enqueue(command: DispatchCommand) {
    const job = await this.queue.add(EXECUTE_COMMAND_JOB, command, {
      jobId: commandJobId(command.commandId)
    });
    this.logger.log("info", {
      event: "bullmq.job.queued",
      commandId: command.commandId,
      sessionId: command.sessionId,
      commandType: command.type,
      ...(job.id === undefined ? {} : { jobId: job.id })
    });
  }

  async ready() {
    await this.queue.waitUntilReady();
  }

  close() {
    this.closePromise ??= this.queue.close();
    return this.closePromise;
  }

  private logInfrastructureError(event: string, error: unknown) {
    this.logger.log("error", { event, error });
    this.onError(error);
  }
}

export function redisOptionsFromUrl(value: string): RedisOptions {
  const url = new URL(value);
  if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
    throw new Error("REDIS_URL must use the redis: or rediss: protocol.");
  }
  const database = url.pathname === "" || url.pathname === "/"
    ? 0
    : Number(url.pathname.slice(1));
  if (!Number.isInteger(database) || database < 0) {
    throw new Error("REDIS_URL database must be a non-negative integer.");
  }
  return {
    host: stripIpv6Brackets(url.hostname),
    port: url.port ? Number(url.port) : 6379,
    db: database,
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    ...(url.protocol === "rediss:" ? { tls: {} } : {})
  };
}

function commandJobId(commandId: string) {
  return `command-${createHash("sha256").update(commandId).digest("hex")}`;
}

export function isCommandType(value: string): value is CommandType {
  return value === "prompt" || value === "steer" || value === "follow-up" || value === "abort";
}

function stripIpv6Brackets(hostname: string) {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function positive(value: number, name: string) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  return value;
}
