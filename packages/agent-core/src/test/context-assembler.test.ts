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
  assert.deepEqual(context.metadata.diagnostics, {
    budget: {
      messageCount: 1,
      estimatedCharacters: 5,
    },
    injectedSources: [],
    persistentPromptMessageCount: 1,
    transientPromptMessageCount: 0,
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
  assert.deepEqual(context.persistentPromptMessageIndexes, [1]);
  assert.deepEqual(context.transientPromptMessageIndexes, [0, 2]);
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
  assert.deepEqual(context.metadata.diagnostics.injectedSources, [
    "lifecycle.beforeRun.systemPrompt",
    "lifecycle.beforeRun.messages",
    "lifecycle.beforeRun.metadata",
    "lifecycle.beforeContext.systemPrompt",
    "lifecycle.beforeContext.messages",
    "lifecycle.beforeContext.metadata",
  ]);
});

test("ContextAssembler passes input metadata through lifecycle hooks", async () => {
  const seenMetadata: Array<Record<string, unknown> | undefined> = [];
  const assembler = new ContextAssembler({
    lifecycleRunner: createLifecycleRunner({
      beforeRun: [({ metadata }) => {
        seenMetadata.push(metadata);
        return { metadata: { selectedTemplate: "review-template" } };
      }],
      beforeContext: [({ metadata, messages }) => {
        seenMetadata.push(metadata);
        return {
          messages: [
            ...messages,
            createUserMessage(`active slash:${String(metadata?.slashCommand)}`),
          ],
        };
      }],
    }),
  });

  const context = await assembler.assemble({
    command: { type: "prompt", text: "/review src/runtime.ts" },
    baseSystemPrompt: "base prompt",
    conversationMessages: [],
    metadata: {
      slashCommand: "review",
      args: { raw: "src/runtime.ts" },
    },
  });

  assert.deepEqual(seenMetadata, [
    {
      slashCommand: "review",
      args: { raw: "src/runtime.ts" },
    },
    {
      slashCommand: "review",
      selectedTemplate: "review-template",
      args: { raw: "src/runtime.ts" },
    },
  ]);
  assert.deepEqual(context.metadata.hooks, {
    slashCommand: "review",
    selectedTemplate: "review-template",
    args: { raw: "src/runtime.ts" },
  });
  assert.deepEqual(context.promptMessages.map(readTextFromMessage), [
    "/review src/runtime.ts",
    "active slash:review",
  ]);
  assert.deepEqual(context.persistentPromptMessageIndexes, [0]);
  assert.deepEqual(context.transientPromptMessageIndexes, [1]);
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
