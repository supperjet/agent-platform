import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { DefaultBrowserEventProjector } from "../consumer/browser-events.js";
import { RedisPublicEventStream } from "../consumer/redis-public-event-stream.js";
import { RedisCommandEventStream } from "../session/redis/redis-command-event-stream.js";

const redisUrl = process.env.REDIS_INTEGRATION_URL;

test("streams correlated Worker events to the Server with replayable storage", {
  skip: redisUrl ? false : "REDIS_INTEGRATION_URL is not configured."
}, async () => {
  const key = `agent-platform:test:public-events:${randomUUID()}`;
  const writer = new RedisCommandEventStream({ redisUrl: redisUrl!, key });
  const reader = new RedisPublicEventStream(
    new DefaultBrowserEventProjector(),
    { redisUrl: redisUrl!, key, blockMilliseconds: 50 }
  );
  const replayReader = new RedisPublicEventStream(
    new DefaultBrowserEventProjector(),
    { redisUrl: redisUrl!, key, blockMilliseconds: 50 }
  );
  const received: string[] = [];
  reader.subscribe("session-1", (event) => received.push(event.type));

  try {
    await Promise.all([writer.ready(), reader.ready()]);
    await writer.run("session-1", "command-1", async () => {
      writer.accept({ type: "run_started", sessionId: "session-1" });
    });
    await waitFor(() => received.length === 1);

    assert.deepEqual(received, ["run_started"]);
    assert.equal(reader.read("session-1")[0]?.commandId, "command-1");
    await reader.close();
    await replayReader.ready();
    assert.equal(replayReader.read("session-1")[0]?.commandId, "command-1");
  } finally {
    await writer.close();
    await reader.close();
    await replayReader.close();
    const redis = new Redis(redisUrl!);
    await redis.del(key);
    await redis.quit();
  }
});

async function waitFor(condition: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the streamed event.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
