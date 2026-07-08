import assert from "node:assert/strict";
import test from "node:test";
import { DefaultBrowserEventProjector } from "../consumer/browser-events.js";
import { InMemoryPublicEventStream } from "../consumer/public-event-stream.js";

test("records correlated events and notifies only the matching Session", async () => {
  const events = new InMemoryPublicEventStream(new DefaultBrowserEventProjector());
  const received: string[] = [];
  events.subscribe("session-1", (event) => received.push(event.type));

  await events.run("session-1", "command-1", async () => {
    events.accept({ type: "run_started", sessionId: "session-1" });
  });

  assert.deepEqual(received, ["run_started"]);
  assert.deepEqual(events.read("session-1").map(({ commandId, sequence }) => ({
    commandId,
    sequence
  })), [{ commandId: "command-1", sequence: 1 }]);
});
