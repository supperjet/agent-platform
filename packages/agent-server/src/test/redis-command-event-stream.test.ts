import assert from "node:assert/strict";
import test from "node:test";
import { decodePublicEventEnvelope } from "../session/redis/public-event-envelope.js";
import { RedisCommandEventStream } from "../session/redis/redis-command-event-stream.js";

test("appends a correlated Runtime event to the Redis Stream", async () => {
  const redis = new FakeStreamWriter();
  const events = new RedisCommandEventStream({ redisUrl: "redis://unused" }, redis);

  await events.run("session-1", "command-1", async () => {
    events.accept({ type: "run_started", sessionId: "session-1" });
  });
  await events.close();

  assert.equal(redis.appends.length, 1);
  assert.equal(redis.appends[0]?.key, "agent-platform:public-events:v1");
  assert.deepEqual(decodePublicEventEnvelope(redis.appends[0]!.message), {
    version: 1,
    commandId: "command-1",
    notification: { type: "run_started", sessionId: "session-1" }
  });
});

test("keeps command correlation isolated across concurrent executions", async () => {
  const redis = new FakeStreamWriter();
  const events = new RedisCommandEventStream({ redisUrl: "redis://unused" }, redis);

  await Promise.all([
    events.run("session-1", "command-1", async () => {
      await new Promise((resolve) => setImmediate(resolve));
      events.accept({ type: "run_started", sessionId: "session-1" });
    }),
    events.run("session-2", "command-2", async () => {
      events.accept({ type: "run_started", sessionId: "session-2" });
    })
  ]);
  await events.close();

  assert.deepEqual(redis.appends.map(({ message }) => {
    const envelope = decodePublicEventEnvelope(message)!;
    return [envelope.notification.sessionId, envelope.commandId];
  }).sort(), [
    ["session-1", "command-1"],
    ["session-2", "command-2"]
  ]);
});

class FakeStreamWriter {
  status = "ready";
  readonly appends: Array<{ key: string; message: string }> = [];

  async connect() {}
  async xadd(key: string, ...args: Array<string | number>) {
    this.appends.push({ key, message: String(args.at(-1)) });
    return "1-0";
  }
  async quit() {
    this.status = "end";
  }
  disconnect() {
    this.status = "end";
  }
  on(_event: "error", _listener: (error: Error) => void) {}
}
