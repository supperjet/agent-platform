import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { ContextBudget } from "../context/context-budget.js";
import {
  createConversationCompactionPlan,
  createConversationCompactionPlanWithSummarizer,
  type ConversationCompactionSelectionStage,
} from "../conversation/conversation-compactor.js";
import type { ConversationMessageEntry } from "../conversation/conversation-entry.js";
import { createUserMessage } from "../runtime/messages.js";

test("default manual compaction uses composite keep-last stage selection", () => {
  const entries = [
    createTestMessageEntry("entry:1", null, createUserMessage("old one")),
    createTestMessageEntry("entry:2", "entry:1", createUserMessage("old two")),
    createTestMessageEntry("entry:3", "entry:2", createUserMessage("recent")),
  ];

  const plan = createConversationCompactionPlan({
    entries,
    leafId: "entry:3",
    reason: "manual",
    keepLastMessages: 1,
  });

  assert.ok(plan);
  assert.equal(plan.selection?.mode, "composite");
  assert.deepEqual(plan.sourceEntryIds, ["entry:1", "entry:2"]);
  assert.deepEqual(plan.preservedEntryIds, ["entry:3"]);
});

test("keep-last stage can select older sources without a token target", () => {
  const entries = [
    createTestMessageEntry("entry:1", null, createUserMessage("old one")),
    createTestMessageEntry("entry:2", "entry:1", createUserMessage("old two")),
    createTestMessageEntry("entry:3", "entry:2", createUserMessage("recent")),
  ];

  const plan = createConversationCompactionPlan({
    entries,
    leafId: "entry:3",
    reason: "manual",
    selection: {
      protectLastMessages: 1,
      stages: [{ mode: "keep-last" }],
    },
  });

  assert.ok(plan);
  assert.equal(plan.selection?.mode, "composite");
  assert.deepEqual(plan.selection?.targetTokens, undefined);
  assert.deepEqual(plan.sourceEntryIds, ["entry:1", "entry:2"]);
  assert.deepEqual(plan.preservedEntryIds, ["entry:3"]);
});

test("compactor does not apply runtime policy default stages implicitly", () => {
  const entries = [
    createTestMessageEntry("entry:1", null, createUserMessage("large old ".repeat(50))),
    createTestMessageEntry("entry:2", "entry:1", createUserMessage("recent")),
  ];

  const plan = createConversationCompactionPlan({
    entries,
    leafId: "entry:2",
    reason: "threshold",
    selection: {
      contextBudget: new ContextBudget(),
      targetTokens: 10,
    },
  });

  assert.equal(plan, undefined);
});

test("composite compaction keeps assistant tool calls paired with tool results", () => {
  const toolCallId = "call:inspect";
  const entries = [
    createTestMessageEntry("entry:1", null, createUserMessage("old request")),
    createTestMessageEntry(
      "entry:2",
      "entry:1",
      fauxAssistantMessage(fauxToolCall("inspect", { topic: "runtime" }, { id: toolCallId })),
    ),
    createTestMessageEntry(
      "entry:3",
      "entry:2",
      createToolResultMessage(toolCallId, "large tool result ".repeat(40)),
    ),
    createTestMessageEntry("entry:4", "entry:3", createUserMessage("recent decision")),
  ];

  const plan = createConversationCompactionPlan({
    entries,
    leafId: "entry:4",
    reason: "threshold",
    selection: {
      contextBudget: new ContextBudget(),
      targetTokens: 40,
      nextMessages: [createUserMessage("continue")],
      protectLastMessages: 1,
      stages: [{ mode: "role-aware" }],
    },
  });

  assert.ok(plan);
  assert.equal(plan.selection?.mode, "composite");
  assert.equal(plan.sourceEntryIds.includes("entry:2"), true);
  assert.equal(plan.sourceEntryIds.includes("entry:3"), true);
  assert.deepEqual(plan.preservedEntryIds, ["entry:1", "entry:4"]);
});

test("role-aware compaction preserves assistant replies before older user inputs by default", () => {
  const entries = [
    createTestMessageEntry("entry:1", null, createUserMessage("old user constraint")),
    createTestMessageEntry("entry:2", "entry:1", createAssistantMessage("old assistant answer")),
    createTestMessageEntry("entry:3", "entry:2", createUserMessage("recent")),
  ];

  const plan = createConversationCompactionPlan({
    entries,
    leafId: "entry:3",
    reason: "threshold",
    selection: {
      contextBudget: new ContextBudget({
        tokenEstimator: () => 20,
      }),
      targetTokens: 60,
      protectLastMessages: 1,
      stages: [{ mode: "role-aware" }],
    },
  });

  assert.ok(plan);
  assert.deepEqual(plan.sourceEntryIds, ["entry:1"]);
  assert.deepEqual(plan.preservedEntryIds, ["entry:2", "entry:3"]);
});

test("largest-first compaction protects recent messages before choosing large sources", () => {
  const stages: ConversationCompactionSelectionStage[] = [{ mode: "largest-first" }];
  const entries = [
    createTestMessageEntry("entry:1", null, createUserMessage("small old")),
    createTestMessageEntry("entry:2", "entry:1", createUserMessage("large old ".repeat(50))),
    createTestMessageEntry("entry:3", "entry:2", createUserMessage("large recent ".repeat(50))),
  ];

  const plan = createConversationCompactionPlan({
    entries,
    leafId: "entry:3",
    reason: "threshold",
    selection: {
      contextBudget: new ContextBudget(),
      targetTokens: 70,
      protectLastMessages: 1,
      stages,
    },
  });

  assert.ok(plan);
  assert.equal(plan.sourceEntryIds.includes("entry:2"), true);
  assert.equal(plan.sourceEntryIds.includes("entry:3"), false);
  assert.deepEqual(plan.selection?.protectedEntryIds, ["entry:3"]);
});

test("stage-level protection can preserve recent candidates within one selector stage", () => {
  const entries = [
    createTestMessageEntry("entry:1", null, createUserMessage("small old")),
    createTestMessageEntry("entry:2", "entry:1", createUserMessage("large middle ".repeat(30))),
    createTestMessageEntry("entry:3", "entry:2", createUserMessage("large recent ".repeat(30))),
    createTestMessageEntry("entry:4", "entry:3", createUserMessage("latest")),
  ];

  const plan = createConversationCompactionPlan({
    entries,
    leafId: "entry:4",
    reason: "threshold",
    selection: {
      contextBudget: new ContextBudget(),
      targetTokens: 60,
      protectLastMessages: 0,
      stages: [{ mode: "largest-first", protectLastMessages: 2 }],
    },
  });

  assert.ok(plan);
  assert.equal(plan.sourceEntryIds.includes("entry:2"), true);
  assert.equal(plan.sourceEntryIds.includes("entry:3"), false);
});

test("selection result reports each compaction stage output", () => {
  const entries = [
    createTestMessageEntry("entry:1", null, createUserMessage("old user")),
    createTestMessageEntry("entry:2", "entry:1", createAssistantMessage("large assistant ".repeat(40))),
    createTestMessageEntry("entry:3", "entry:2", createUserMessage("large middle ".repeat(40))),
    createTestMessageEntry("entry:4", "entry:3", createUserMessage("recent")),
  ];

  const plan = createConversationCompactionPlan({
    entries,
    leafId: "entry:4",
    reason: "threshold",
    selection: {
      contextBudget: new ContextBudget({
        tokenEstimator: ({ text }) => text.length,
      }),
      targetTokens: 80,
      protectLastMessages: 1,
      stages: [
        { mode: "role-aware", dropPriority: { user: 100, assistant: 1 }, protectLastMessages: 3 },
        { mode: "largest-first" },
        { mode: "token-budget" },
      ],
    },
  });

  assert.ok(plan);
  assert.equal(plan.selection?.stageResults.length, 2);
  assert.deepEqual(plan.selection?.stageResults[0]?.selectedEntryIds, ["entry:1"]);
  assert.equal(plan.selection?.stageResults[1]?.selectedEntryIds.includes("entry:2"), true);
  assert.equal(plan.selection?.stageResults[1]?.reachedTarget, true);
  assert.equal(plan.selection?.stageResults[1]?.selectedGroups[0]?.roles.includes("assistant"), true);
});

test("custom summarizer receives original selected messages", async () => {
  const entries = [
    createTestMessageEntry("entry:1", null, createUserMessage("old user decision")),
    createTestMessageEntry("entry:2", "entry:1", createAssistantMessage("old assistant answer")),
    createTestMessageEntry("entry:3", "entry:2", createUserMessage("recent")),
  ];
  const seen: Array<{
    sourceEntryIds: readonly string[];
    sourceTexts: readonly string[];
    preservedEntryIds: readonly string[];
    instructions?: string;
  }> = [];

  const plan = await createConversationCompactionPlanWithSummarizer({
    entries,
    leafId: "entry:3",
    reason: "manual",
    keepLastMessages: 1,
    instructions: "Keep durable decisions.",
    summarizer: {
      summarize(input) {
        seen.push({
          sourceEntryIds: input.sourceEntryIds,
          sourceTexts: input.sourceMessages.map((entry) => readMessageText(entry.payload.message)),
          preservedEntryIds: input.preservedEntryIds,
          ...(input.instructions ? { instructions: input.instructions } : {}),
        });
        return "LLM summary from original messages";
      },
    },
  });

  assert.ok(plan);
  assert.equal(plan.summary, "LLM summary from original messages");
  assert.deepEqual(seen, [{
    sourceEntryIds: ["entry:1", "entry:2"],
    sourceTexts: ["old user decision", "old assistant answer"],
    preservedEntryIds: ["entry:3"],
    instructions: "Keep durable decisions.",
  }]);
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

function createAssistantMessage(text: string): AgentMessage {
  return fauxAssistantMessage(fauxText(text));
}

function createToolResultMessage(
  toolCallId: string,
  text: string,
): AgentMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "inspect",
    content: [fauxText(text)],
    isError: false,
    timestamp: Date.now(),
  };
}

function readMessageText(message: AgentMessage): string {
  if (!("content" in message)) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((block: unknown) => {
    if (!block || typeof block !== "object") return [];
    if (!("type" in block) || block.type !== "text") return [];
    return "text" in block && typeof block.text === "string" ? [block.text] : [];
  }).join("\n");
}
