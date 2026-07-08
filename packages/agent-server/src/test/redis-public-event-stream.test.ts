import assert from "node:assert/strict";
import test from "node:test";
import { DefaultBrowserEventProjector } from "../consumer/browser-events.js";
import { RedisPublicEventStream } from "../consumer/redis-public-event-stream.js";

test("replays retained Redis Stream events through the public stream interface", async () => {
  const redis = new FakeStreamReader([
    ["10-0", ["event", JSON.stringify({
      version: 1,
      commandId: "command-1",
      notification: { type: "run_started", sessionId: "session-1" }
    })]]
  ]);
  const events = new RedisPublicEventStream(
    new DefaultBrowserEventProjector(),
    { redisUrl: "redis://unused" },
    redis
  );

  await events.ready();

  assert.deepEqual(events.read("session-1").map(({ eventId, commandId, type }) => ({
    eventId,
    commandId,
    type
  })), [{ eventId: "10-0", commandId: "command-1", type: "run_started" }]);
  await events.close();
});

test("tails new Redis Stream events and notifies matching subscribers", async () => {
  const redis = new FakeStreamReader([]);
  const events = new RedisPublicEventStream(
    new DefaultBrowserEventProjector(),
    { redisUrl: "redis://unused" },
    redis
  );
  const received: string[] = [];
  events.subscribe("session-1", (event) => received.push(event.type));
  await events.ready();

  redis.append(["11-0", ["event", JSON.stringify({
    version: 1,
    commandId: "command-2",
    notification: { type: "run_finished", sessionId: "session-1" }
  })]]);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(received, ["run_finished"]);
  await events.close();
});

class FakeStreamReader {
  status = "ready";
  private rejectRead: ((error: Error) => void) | undefined;
  private resolveRead: ((result: [[string, Array<[string, string[]]>]]) => void) | undefined;

  constructor(private readonly retained: Array<[string, string[]]>) {}

  async connect() {}
  async xrange(_key: string, _start: string, _end: string) {
    return this.retained;
  }
  xread(..._args: Array<string | number>): Promise<null | [[string, Array<[string, string[]]>]]> {
    return new Promise((resolve, reject) => {
      this.resolveRead = resolve;
      this.rejectRead = reject;
    });
  }
  append(entry: [string, string[]]) {
    const resolve = this.resolveRead;
    this.resolveRead = undefined;
    resolve?.([["agent-platform:public-events:v1", [entry]]]);
  }
  disconnect() {
    this.status = "end";
    this.rejectRead?.(new Error("disconnected"));
  }
  on(_event: "error", _listener: (error: Error) => void) {}
}
