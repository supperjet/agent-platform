import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  fauxAssistantMessage,
  fauxText,
  registerFauxProvider,
} from "@earendil-works/pi-ai";
import {
  createConversationCompactionPlanWithSummarizer,
} from "../conversation/conversation-compactor.js";
import type { ConversationMessageEntry } from "../conversation/conversation-entry.js";
import { createLlmConversationSummarizer } from "../conversation/llm-conversation-summarizer.js";
import { createUserMessage } from "../runtime/messages.js";

test("LLM conversation summarizer sends selected original messages to the model", async () => {
  const registration = registerFauxProvider({ provider: "agent-core-compaction-llm-test" });
  const prompts: string[] = [];
  const apiKeys: Array<string | undefined> = [];
  registration.setResponses([
    (context, options) => {
      apiKeys.push(options?.apiKey);
      const prompt = String(context.messages[0]?.content ?? "");
      prompts.push(prompt);
      return fauxAssistantMessage(fauxText("LLM summary: preserve old user decision."));
    },
  ]);

  try {
    const entries = [
      createTestMessageEntry("entry:1", null, createUserMessage("old user decision")),
      createTestMessageEntry("entry:2", "entry:1", createUserMessage("recent context")),
    ];
    const plan = await createConversationCompactionPlanWithSummarizer({
      entries,
      leafId: "entry:2",
      reason: "manual",
      keepLastMessages: 1,
      summarizer: createLlmConversationSummarizer({
        model: registration.getModel(),
        resolveApiKey: () => "summary-key",
        now: () => 123,
      }),
    });

    assert.ok(plan);
    assert.equal(plan.summary, "LLM summary: preserve old user decision.");
    assert.deepEqual(apiKeys, ["summary-key"]);
    assert.equal(prompts.length, 1);
    assert.match(prompts[0] ?? "", /selectedMessages/);
    assert.match(prompts[0] ?? "", /old user decision/);
    assert.doesNotMatch(prompts[0] ?? "", /recent context/);
  } finally {
    registration.unregister();
  }
});

test("LLM conversation summarizer renders structured JSON summaries as stable text", async () => {
  const registration = registerFauxProvider({ provider: "agent-core-compaction-llm-structured-test" });
  const systemPrompts: string[] = [];
  registration.setResponses([
    (context) => {
      systemPrompts.push(String((context as { systemPrompt?: unknown }).systemPrompt ?? ""));
      return fauxAssistantMessage(fauxText(JSON.stringify({
        summary: "User wants structured compaction.",
        facts: ["The selected source contains an old requirement."],
        decisions: ["Use structured-json output."],
        openQuestions: [],
        currentTaskState: ["Compaction summary is being generated."],
        risks: ["Invalid JSON should fail closed by default."],
      })));
    },
  ]);

  try {
    const plan = await createConversationCompactionPlanWithSummarizer({
      entries: [
        createTestMessageEntry("entry:1", null, createUserMessage("old requirement")),
        createTestMessageEntry("entry:2", "entry:1", createUserMessage("recent context")),
      ],
      leafId: "entry:2",
      reason: "manual",
      keepLastMessages: 1,
      summarizer: createLlmConversationSummarizer({
        model: registration.getModel(),
        resolveApiKey: () => "summary-key",
        outputFormat: "structured-json",
      }),
    });

    assert.ok(plan);
    assert.equal(plan.summary, [
      "User wants structured compaction.",
      "",
      "Facts:",
      "- The selected source contains an old requirement.",
      "",
      "Decisions:",
      "- Use structured-json output.",
      "",
      "Current Task State:",
      "- Compaction summary is being generated.",
      "",
      "Risks:",
      "- Invalid JSON should fail closed by default.",
    ].join("\n"));
    assert.match(systemPrompts[0] ?? "", /Return only valid JSON/);
  } finally {
    registration.unregister();
  }
});

test("LLM conversation summarizer rejects invalid structured JSON by default", async () => {
  const registration = registerFauxProvider({ provider: "agent-core-compaction-llm-invalid-structured-test" });
  registration.setResponses([
    fauxAssistantMessage(fauxText("not json")),
  ]);

  try {
    await assert.rejects(
      () => createConversationCompactionPlanWithSummarizer({
        entries: [
          createTestMessageEntry("entry:1", null, createUserMessage("old")),
          createTestMessageEntry("entry:2", "entry:1", createUserMessage("recent")),
        ],
        leafId: "entry:2",
        reason: "manual",
        keepLastMessages: 1,
        summarizer: createLlmConversationSummarizer({
          model: registration.getModel(),
          resolveApiKey: () => "summary-key",
          outputFormat: "structured-json",
        }),
      }),
      /invalid structured JSON/,
    );
  } finally {
    registration.unregister();
  }
});

test("LLM conversation summarizer can fall back when structured JSON is invalid", async () => {
  const registration = registerFauxProvider({ provider: "agent-core-compaction-llm-invalid-structured-fallback-test" });
  registration.setResponses([
    fauxAssistantMessage(fauxText("not json")),
  ]);

  try {
    const plan = await createConversationCompactionPlanWithSummarizer({
      entries: [
        createTestMessageEntry("entry:1", null, createUserMessage("old durable fact")),
        createTestMessageEntry("entry:2", "entry:1", createUserMessage("recent")),
      ],
      leafId: "entry:2",
      reason: "manual",
      keepLastMessages: 1,
      summarizer: createLlmConversationSummarizer({
        model: registration.getModel(),
        resolveApiKey: () => "summary-key",
        outputFormat: "structured-json",
        failureStrategy: "fallback-summary",
      }),
    });

    assert.ok(plan);
    assert.match(plan.summary, /已压缩 1 条历史消息。/);
    assert.match(plan.summary, /old durable fact/);
  } finally {
    registration.unregister();
  }
});

test("LLM conversation summarizer rejects provider error summaries", async () => {
  const registration = registerFauxProvider({ provider: "agent-core-compaction-llm-error-test" });
  registration.setResponses([
    fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "summary provider unavailable",
    }),
  ]);

  try {
    await assert.rejects(
      () => createConversationCompactionPlanWithSummarizer({
        entries: [
          createTestMessageEntry("entry:1", null, createUserMessage("old")),
          createTestMessageEntry("entry:2", "entry:1", createUserMessage("recent")),
        ],
        leafId: "entry:2",
        reason: "manual",
        keepLastMessages: 1,
        summarizer: createLlmConversationSummarizer({
          model: registration.getModel(),
          resolveApiKey: () => "summary-key",
        }),
      }),
      /summary provider unavailable/,
    );
  } finally {
    registration.unregister();
  }
});

test("LLM conversation summarizer can fall back to deterministic summaries on provider failure", async () => {
  const registration = registerFauxProvider({ provider: "agent-core-compaction-llm-fallback-test" });
  registration.setResponses([
    fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "summary provider unavailable",
    }),
  ]);

  try {
    const plan = await createConversationCompactionPlanWithSummarizer({
      entries: [
        createTestMessageEntry("entry:1", null, createUserMessage("old durable fact")),
        createTestMessageEntry("entry:2", "entry:1", createUserMessage("recent")),
      ],
      leafId: "entry:2",
      reason: "manual",
      instructions: "Keep durable facts.",
      keepLastMessages: 1,
      summarizer: createLlmConversationSummarizer({
        model: registration.getModel(),
        resolveApiKey: () => "summary-key",
        failureStrategy: "fallback-summary",
      }),
    });

    assert.ok(plan);
    assert.equal(plan.summary, [
      "已压缩 1 条历史消息。",
      "压缩指令：Keep durable facts.",
      "1. user: old durable fact",
    ].join("\n"));
  } finally {
    registration.unregister();
  }
});

test("LLM conversation summarizer fails closed when the summarizer prompt exceeds its input budget", async () => {
  const registration = registerFauxProvider({ provider: "agent-core-compaction-llm-budget-test" });
  let providerCalls = 0;
  registration.setResponses([
    () => {
      providerCalls += 1;
      return fauxAssistantMessage(fauxText("should not be called"));
    },
  ]);

  try {
    await assert.rejects(
      () => createConversationCompactionPlanWithSummarizer({
        entries: [
          createTestMessageEntry("entry:1", null, createUserMessage("old durable fact ".repeat(20))),
          createTestMessageEntry("entry:2", "entry:1", createUserMessage("recent")),
        ],
        leafId: "entry:2",
        reason: "manual",
        keepLastMessages: 1,
        summarizer: createLlmConversationSummarizer({
          model: registration.getModel(),
          resolveApiKey: () => "summary-key",
          maxInputTokens: 1,
        }),
      }),
      /input budget exceeded/,
    );
    assert.equal(providerCalls, 0);
  } finally {
    registration.unregister();
  }
});

test("LLM conversation summarizer can fall back before calling the model when its input budget is exceeded", async () => {
  const registration = registerFauxProvider({ provider: "agent-core-compaction-llm-budget-fallback-test" });
  let providerCalls = 0;
  registration.setResponses([
    () => {
      providerCalls += 1;
      return fauxAssistantMessage(fauxText("should not be called"));
    },
  ]);

  try {
    const plan = await createConversationCompactionPlanWithSummarizer({
      entries: [
        createTestMessageEntry("entry:1", null, createUserMessage("old durable fact ".repeat(20))),
        createTestMessageEntry("entry:2", "entry:1", createUserMessage("recent")),
      ],
      leafId: "entry:2",
      reason: "manual",
      keepLastMessages: 1,
      summarizer: createLlmConversationSummarizer({
        model: registration.getModel(),
        resolveApiKey: () => "summary-key",
        failureStrategy: "fallback-summary",
        maxInputTokens: 1,
      }),
    });

    assert.ok(plan);
    assert.match(plan.summary, /已压缩 1 条历史消息。/);
    assert.match(plan.summary, /old durable fact/);
    assert.equal(providerCalls, 0);
  } finally {
    registration.unregister();
  }
});

function createTestMessageEntry(
  id: string,
  parentId: string | null,
  message: AgentMessage,
): ConversationMessageEntry {
  return {
    kind: "message",
    id,
    parentId,
    createdAt: "2026-07-30T00:00:00.000Z",
    payload: { message },
  };
}
