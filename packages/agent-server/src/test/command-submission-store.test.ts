import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryCommandRepository } from "../session/memory/in-memory-command-repository.js";
import { InMemoryCommandSubmissionStore } from "../session/memory/in-memory-command-submission-store.js";

test("submits a new command directly in queued state", async () => {
  const commands = new InMemoryCommandRepository();
  const submissions = new InMemoryCommandSubmissionStore(commands, () => 1_000);

  const result = await submissions.createQueuedIfAbsent({
    commandId: "command-1",
    sessionId: "session-1",
    type: "prompt",
    text: "hello"
  });

  assert.deepEqual(result, {
    created: true,
    command: {
      commandId: "command-1",
      sessionId: "session-1",
      type: "prompt",
      text: "hello",
      accepted: true,
      status: "queued",
      createdAt: 1_000,
      updatedAt: 1_000
    }
  });
});

test("returns the original command for an identical retry", async () => {
  const commands = new InMemoryCommandRepository();
  const submissions = new InMemoryCommandSubmissionStore(commands, () => 1_000);
  const command = {
    commandId: "command-1",
    sessionId: "session-1",
    type: "prompt" as const,
    text: "hello"
  };

  await submissions.createQueuedIfAbsent(command);
  const retry = await submissions.createQueuedIfAbsent(command);

  assert.equal(retry.created, false);
  assert.equal(retry.command.status, "queued");
});
