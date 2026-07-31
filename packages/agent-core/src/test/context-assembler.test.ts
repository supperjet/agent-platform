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
  assert.equal(context.metadata.budget.messageCount, 1);
  assert.equal(context.metadata.budget.estimatedCharacters, 5);
  assert.equal(context.metadata.budget.systemPromptCharacters, 11);
  assert.equal(context.metadata.budget.status, "normal");
  assert.equal(context.metadata.budget.recommendedAction, "none");
  assert.deepEqual({
    budget: {
      messageCount: context.metadata.diagnostics.budget.messageCount,
      estimatedCharacters: context.metadata.diagnostics.budget.estimatedCharacters,
      systemPromptCharacters: context.metadata.diagnostics.budget.systemPromptCharacters,
      status: context.metadata.diagnostics.budget.status,
      recommendedAction: context.metadata.diagnostics.budget.recommendedAction,
    },
    injectedSources: [],
    persistentPromptMessageCount: 1,
    transientPromptMessageCount: 0,
  }, {
    budget: {
      messageCount: 1,
      estimatedCharacters: 5,
      systemPromptCharacters: 11,
      status: "normal",
      recommendedAction: "none",
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
    systemPromptCharacters: 0,
    totalEstimatedCharacters: 10,
    estimatedTokens: 20,
    maxTokens: 122880,
    remainingTokens: 122860,
    pressure: 20 / 122880,
    overflow: false,
    status: "normal",
    shouldCompact: false,
    recommendedAction: "none",
    budgetSource: "default",
    model: {
      maxContextTokens: 128000,
      reservedOutputTokens: 4096,
      safetyMarginTokens: 1024,
    },
    largestMessages: [
      {
        index: 0,
        role: "user",
        estimatedCharacters: 5,
        estimatedTokens: 10,
      },
      {
        index: 1,
        role: "user",
        estimatedCharacters: 5,
        estimatedTokens: 10,
      },
    ],
  });
  assert.deepEqual(messages.map(readTextFromMessage), ["hello", "world"]);
});

test("ContextBudget classifies context pressure without mutating messages", () => {
  const budget = new ContextBudget({
    maxTokens: 100,
    tokenEstimator: ({ characterCount }) => characterCount,
  });
  const normal = [createUserMessage("1234567890")];
  const pressured = [createUserMessage("x".repeat(75))];
  const critical = [createUserMessage("x".repeat(80))];
  const overflow = [createUserMessage("x".repeat(100))];

  assert.equal(budget.estimate(normal).status, "normal");
  assert.equal(budget.estimate(pressured).status, "pressured");
  assert.equal(budget.estimate(critical).status, "critical");
  assert.equal(budget.estimate(overflow).status, "overflow");
  assert.equal(budget.estimate(critical).recommendedAction, "compact");
  assert.deepEqual(normal.map(readTextFromMessage), ["1234567890"]);
});

test("ContextBudget reports model budget source and largest messages", () => {
  const budget = new ContextBudget({
    model: {
      provider: "provider-a",
      modelId: "model-a",
      maxContextTokens: 1000,
      maxOutputTokens: 100,
    },
    safetyMarginTokens: 50,
    tokenEstimator: ({ characterCount }) => characterCount,
    largestMessageLimit: 1,
  });

  const estimate = budget.estimate([
    createUserMessage("small"),
    createUserMessage("x".repeat(100)),
  ], { systemPrompt: "system" });

  assert.equal(estimate.budgetSource, "model");
  assert.deepEqual(estimate.model, {
    provider: "provider-a",
    modelId: "model-a",
    maxContextTokens: 1000,
    reservedOutputTokens: 100,
    safetyMarginTokens: 50,
  });
  assert.equal(estimate.maxTokens, 850);
  assert.deepEqual(estimate.largestMessages, [
    {
      index: 1,
      role: "user",
      estimatedCharacters: 100,
      estimatedTokens: 108,
    },
  ]);
});

function readTextFromMessage(message: AgentMessage): string {
  if (!("content" in message) || !Array.isArray(message.content)) return "";
  return message.content.flatMap((block: unknown) => {
    if (!block || typeof block !== "object" || !("type" in block) || block.type !== "text") return [];
    return "text" in block && typeof block.text === "string" ? [block.text] : [];
  }).join("\n");
}
