import assert from "node:assert/strict";
import test from "node:test";
import { createLifecycleRunner } from "../lifecycle/lifecycle-runner.js";
import { InputProcessor } from "../prompt/input-processor.js";

test("InputProcessor keeps the command when onInput continues", async () => {
  const command = { type: "prompt", text: "hello" } as const;
  const processor = new InputProcessor({
    lifecycleRunner: createLifecycleRunner({
      onInput: [() => ({ action: "continue" })],
    }),
  });

  assert.deepEqual(await processor.process({ command }), {
    status: "ready",
    command,
  });
});

test("InputProcessor returns the transformed command from onInput", async () => {
  const processor = new InputProcessor({
    lifecycleRunner: createLifecycleRunner({
      onInput: [
        ({ command }) => {
          assert.equal(command.type, "prompt");
          return {
            action: "transform",
            command: { type: "prompt", text: "expanded prompt" },
          };
        },
      ],
    }),
  });

  assert.deepEqual(
    await processor.process({
      command: { type: "prompt", text: "/expand" },
    }),
    {
      status: "ready",
      command: { type: "prompt", text: "expanded prompt" },
    },
  );
});

test("InputProcessor short-circuits handled input", async () => {
  const calls: string[] = [];
  const processor = new InputProcessor({
    lifecycleRunner: createLifecycleRunner({
      onInput: [
        () => {
          calls.push("first");
          return { action: "handled" };
        },
        () => {
          calls.push("second");
          return { action: "continue" };
        },
      ],
    }),
  });

  assert.deepEqual(
    await processor.process({
      command: { type: "prompt", text: "/local" },
    }),
    { status: "handled" },
  );
  assert.deepEqual(calls, ["first"]);
});
