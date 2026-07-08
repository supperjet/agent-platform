import { Redis } from "ioredis";
import type { ExecutionLogger } from "../session/contracts.js";
import {
  decodePublicEventEnvelope,
  PUBLIC_EVENT_STREAM_FIELD,
  PUBLIC_EVENT_STREAM_KEY
} from "../session/redis/public-event-envelope.js";
import type { BrowserEventProjector } from "./browser-events.js";
import {
  InMemoryPublicEventStream,
  PublicEventStream,
  type PublicEventListener
} from "./public-event-stream.js";

type StreamEntry = [id: string, fields: string[]];
type StreamReadResult = Array<[key: string, entries: StreamEntry[]]> | null;

type StreamReader = {
  status: string;
  connect(): Promise<unknown>;
  xrange(key: string, start: string, end: string): Promise<StreamEntry[]>;
  xread(...args: Array<string | number>): Promise<StreamReadResult>;
  disconnect(): void;
  on(event: "error", listener: (error: Error) => void): unknown;
};

export type RedisPublicEventStreamOptions = {
  redisUrl: string;
  key?: string;
  blockMilliseconds?: number;
  logger?: ExecutionLogger;
};

/** Server-side adapter: replays and tails Redis Stream entries behind the PublicEventStream seam. */
export class RedisPublicEventStream extends PublicEventStream {
  private readonly events: InMemoryPublicEventStream;
  private readonly redis: StreamReader;
  private readonly key: string;
  private readonly blockMilliseconds: number;
  private readonly logger: ExecutionLogger;
  private lastId = "0-0";
  private reading?: Promise<void>;
  private readyPromise?: Promise<void>;
  private closed = false;

  constructor(
    projector: BrowserEventProjector,
    options: RedisPublicEventStreamOptions,
    redis?: StreamReader
  ) {
    super();
    this.events = new InMemoryPublicEventStream(projector);
    this.redis = redis ?? createRedis(options.redisUrl);
    this.key = options.key ?? PUBLIC_EVENT_STREAM_KEY;
    this.blockMilliseconds = options.blockMilliseconds ?? 1_000;
    this.logger = options.logger ?? { log() {} };
    this.redis.on("error", (error) => {
      if (!this.closed) this.logError("redis.public_event_stream.error", error);
    });
  }

  read(sessionId: string) {
    return this.events.read(sessionId);
  }

  subscribe(sessionId: string, listener: PublicEventListener) {
    return this.events.subscribe(sessionId, listener);
  }

  ready() {
    this.readyPromise ??= this.start();
    return this.readyPromise;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.redis.disconnect();
    await this.reading?.catch(() => {});
    this.events.close();
  }

  private async start() {
    if (this.redis.status === "wait") await this.redis.connect();
    const retained = await this.redis.xrange(this.key, "-", "+");
    this.ingest(retained);
    this.reading = this.readLoop();
  }

  private async readLoop() {
    while (!this.closed) {
      try {
        const result = await this.redis.xread(
          "BLOCK",
          this.blockMilliseconds,
          "COUNT",
          100,
          "STREAMS",
          this.key,
          this.lastId
        );
        for (const [, entries] of result ?? []) this.ingest(entries);
      } catch (error) {
        if (!this.closed) {
          this.logError("redis.public_event_stream.read_failed", error);
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
    }
  }

  private ingest(entries: StreamEntry[]) {
    for (const [id, fields] of entries) {
      this.lastId = id;
      const message = readField(fields, PUBLIC_EVENT_STREAM_FIELD);
      const envelope = message ? decodePublicEventEnvelope(message) : undefined;
      if (!envelope) {
        this.logger.log("info", { event: "redis.public_event_stream.invalid_entry" });
        continue;
      }
      this.events.accept(envelope.notification, envelope.commandId, id, occurredAtFromStreamId(id));
    }
  }

  private logError(event: string, error: unknown) {
    this.logger.log("error", { event, error });
  }
}

function readField(fields: string[], name: string) {
  for (let index = 0; index < fields.length; index += 2) {
    if (fields[index] === name) return fields[index + 1];
  }
  return undefined;
}

function occurredAtFromStreamId(id: string) {
  const milliseconds = Number(id.split("-", 1)[0]);
  return Number.isSafeInteger(milliseconds)
    ? new Date(milliseconds).toISOString()
    : new Date().toISOString();
}

function createRedis(redisUrl: string): Redis {
  return new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: null,
    enableOfflineQueue: false
  });
}
