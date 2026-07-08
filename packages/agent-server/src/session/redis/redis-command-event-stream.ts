import { AsyncLocalStorage } from "node:async_hooks";
import { Redis } from "ioredis";
import type { AgentNotification } from "../../messaging/events.js";
import type { ExecutionLogger } from "../contracts.js";
import {
  encodePublicEventEnvelope,
  PUBLIC_EVENT_STREAM_FIELD,
  PUBLIC_EVENT_STREAM_KEY
} from "./public-event-envelope.js";

type StreamWriter = {
  status: string;
  connect(): Promise<unknown>;
  xadd(key: string, ...args: Array<string | number>): Promise<unknown>;
  quit(): Promise<unknown>;
  disconnect(): void;
  on(event: "error", listener: (error: Error) => void): unknown;
};

export type RedisCommandEventStreamOptions = {
  redisUrl: string;
  key?: string;
  maxLength?: number;
  logger?: ExecutionLogger;
};

/** Worker-side deep module: correlates Runtime events and appends them to a bounded Redis Stream. */
export class RedisCommandEventStream {
  private readonly context = new AsyncLocalStorage<{ sessionId: string; commandId: string }>();
  private readonly redis: StreamWriter;
  private readonly key: string;
  private readonly maxLength: number;
  private readonly logger: ExecutionLogger;
  private readonly pending = new Set<Promise<unknown>>();
  private closed = false;

  constructor(options: RedisCommandEventStreamOptions, redis?: StreamWriter) {
    this.redis = redis ?? createRedis(options.redisUrl);
    this.key = options.key ?? PUBLIC_EVENT_STREAM_KEY;
    this.maxLength = options.maxLength ?? 10_000;
    this.logger = options.logger ?? { log() {} };
    this.redis.on("error", (error) => this.logError("redis.command_event_stream.error", error));
  }

  run<T>(sessionId: string, commandId: string, operation: () => Promise<T>) {
    return this.context.run({ sessionId, commandId }, operation);
  }

  accept(notification: AgentNotification) {
    const command = this.context.getStore();
    if (!command || command.sessionId !== notification.sessionId || this.closed) {
      this.logger.log("info", {
        event: "redis.command_event_stream.unattributed",
        sessionId: notification.sessionId
      });
      return;
    }
    const message = encodePublicEventEnvelope({
      version: 1,
      commandId: command.commandId,
      notification
    });
    const appending = this.redis.xadd(
      this.key,
      "MAXLEN",
      "~",
      this.maxLength,
      "*",
      PUBLIC_EVENT_STREAM_FIELD,
      message
    ).catch((error: unknown) => this.logError("redis.command_event_stream.append_failed", error))
      .finally(() => this.pending.delete(appending));
    this.pending.add(appending);
  }

  async ready() {
    if (this.redis.status === "wait") await this.redis.connect();
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await Promise.allSettled([...this.pending]);
    if (this.redis.status === "wait" || this.redis.status === "end") {
      this.redis.disconnect();
      return;
    }
    await this.redis.quit().catch(() => this.redis.disconnect());
  }

  private logError(event: string, error: unknown) {
    this.logger.log("error", { event, error });
  }
}

function createRedis(redisUrl: string): Redis {
  return new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false
  });
}
