import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { ContextAssembler } from "../context/context-assembler.js";
import { ContextBudget } from "../context/context-budget.js";
import { createLifecycleRunner } from "../lifecycle/lifecycle-runner.js";
import { createUserMessage } from "../runtime/messages.js";

test("ContextAssembler creates a prompt turn from a prompt command", async () => {
  const assembler = new ContextAssembler();

  const context = await assembler.assemble({
    command: { type: "prompt", text: "hello" },
    baseSystemPrompt: "base prompt",
    conversationMessages: [],
  });

  assert.equal(context.systemPrompt, "base prompt");
  assert.deepEqual(context.promptMessages.map(readTextFromMessage), ["hello"]);
  assert.deepEqual(context.messages.map(readTextFromMessage), ["hello"]);
  assert.deepEqual(context.metadata.budget, {
    messageCount: 1,
    estimatedCharacters: 5,
  });
});

test("ContextAssembler applies beforeRun and beforeContext to one turn", async () => {
  const previous = createUserMessage("previous");
  const assembler = new ContextAssembler({
    lifecycleRunner: createLifecycleRunner({
      beforeRun: [() => ({
        systemPrompt: "run prompt",
        messages: [createUserMessage("run context")],
        metadata: { source: "beforeRun", run: true },
      })],
      beforeContext: [({ messages, metadata, systemPrompt }) => ({
        systemPrompt: `${systemPrompt} + context prompt`,
        messages: [
          ...messages,
          createUserMessage(`context from ${String(metadata?.source)}`),
        ],
        metadata: { source: "beforeContext", context: true },
      })],
    }),
  });

  const context = await assembler.assemble({
    command: { type: "prompt", text: "hello" },
    baseSystemPrompt: "base prompt",
    conversationMessages: [previous],
  });

  assert.equal(context.systemPrompt, "run prompt + context prompt");
  assert.deepEqual(context.promptMessages.map(readTextFromMessage), [
    "run context",
    "hello",
    "context from beforeRun",
  ]);
  assert.deepEqual(context.messages.map(readTextFromMessage), [
    "previous",
    "run context",
    "hello",
    "context from beforeRun",
  ]);
  assert.deepEqual(context.metadata.hooks, {
    source: "beforeContext",
    run: true,
    context: true,
  });
});

test("ContextAssembler rejects beforeContext replacing the conversation prefix", async () => {
  const previous = createUserMessage("previous");
  const assembler = new ContextAssembler({
    lifecycleRunner: createLifecycleRunner({
      beforeContext: [({ messages }) => ({
        messages: [
          createUserMessage("replacement"),
          ...messages.slice(1),
        ],
      })],
    }),
  });

  await assert.rejects(
    () => assembler.assemble({
      command: { type: "prompt", text: "hello" },
      baseSystemPrompt: "base prompt",
      conversationMessages: [previous],
    }),
    /preserve the existing conversation prefix/,
  );
});

test("ContextBudget estimates messages without mutating them", () => {
  const messages = [
    createUserMessage("hello"),
    createUserMessage("world"),
  ];
  const budget = new ContextBudget();

  assert.deepEqual(budget.estimate(messages), {
    messageCount: 2,
    estimatedCharacters: 10,
  });
  assert.deepEqual(messages.map(readTextFromMessage), ["hello", "world"]);
});

function readTextFromMessage(message: AgentMessage): string {
  if (!("content" in message) || !Array.isArray(message.content)) return "";
  return message.content.flatMap((block: unknown) => {
    if (!block || typeof block !== "object" || !("type" in block) || block.type !== "text") return [];
    return "text" in block && typeof block.text === "string" ? [block.text] : [];
  }).join("\n");
}
