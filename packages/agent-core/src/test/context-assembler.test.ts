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

test("ContextAssembler merges rendered prompt template into prompt messages", async () => {
  const assembler = new ContextAssembler();

  const context = await assembler.assemble({
    command: { type: "prompt", text: "/template review target=src/runtime.ts focus=tests" },
    baseSystemPrompt: "base prompt",
    conversationMessages: [],
    metadata: {
      slashCommand: "template",
      inputMode: "template",
      selectedTemplate: "review",
      promptTemplate: {
        name: "review",
        content: "Review src/runtime.ts with focus tests.",
        variables: {
          target: "src/runtime.ts",
          focus: "tests",
        },
        sourceInfo: { source: "sdk", label: "test", scope: "explicit" },
      },
    },
  });

  assert.deepEqual(context.promptMessages.map(readTextFromMessage), [
    [
      '<prompt_template name="review" source="test">',
      "Review src/runtime.ts with focus tests.",
      "</prompt_template>",
    ].join("\n"),
    "/template review target=src/runtime.ts focus=tests",
  ]);
  assert.deepEqual(context.persistentPromptMessageIndexes, [1]);
  assert.deepEqual(context.transientPromptMessageIndexes, [0]);
  assert.deepEqual(context.metadata.diagnostics.injectedSources, [
    "input.metadata",
    "prompt.template.message",
  ]);
});

test("ContextAssembler merges active skill into transient prompt messages", async () => {
  const assembler = new ContextAssembler();

  const context = await assembler.assemble({
    command: { type: "prompt", text: "/skill use review src/runtime.ts" },
    baseSystemPrompt: "base prompt",
    conversationMessages: [],
    metadata: {
      slashCommand: "skill",
      inputMode: "skill",
      selectedSkill: "review",
      skillActivation: {
        name: "review",
        instructions: "Report findings first.",
        arguments: "src/runtime.ts",
        sourceInfo: { source: "sdk", label: "test", scope: "explicit" },
      },
    },
  });

  assert.deepEqual(context.promptMessages.map(readTextFromMessage), [
    [
      '<skill name="review" source="test">',
      "Report findings first.",
      "",
      "<arguments>",
      "src/runtime.ts",
      "</arguments>",
      "</skill>",
    ].join("\n"),
    "/skill use review src/runtime.ts",
  ]);
  assert.deepEqual(context.persistentPromptMessageIndexes, [1]);
  assert.deepEqual(context.transientPromptMessageIndexes, [0]);
  assert.deepEqual(context.metadata.diagnostics.injectedSources, [
    "input.metadata",
    "skill.activation.message",
  ]);
});

test("ContextAssembler includes active skill references when provided", async () => {
  const assembler = new ContextAssembler();

  const context = await assembler.assemble({
    command: { type: "prompt", text: "/skill use review src/runtime.ts" },
    baseSystemPrompt: "base prompt",
    conversationMessages: [],
    metadata: {
      slashCommand: "skill",
      inputMode: "skill",
      selectedSkill: "review",
      skillActivation: {
        name: "review",
        instructions: "Report findings first.",
        arguments: "src/runtime.ts",
        sourceInfo: { source: "sdk", label: "test", scope: "explicit" },
        supportFiles: [{
          kind: "reference",
          label: "checklist.md",
          sourceInfo: { source: "file", label: "skills/review/references/checklist.md", scope: "project" },
          trustPolicy: {
            canRead: true,
            canInject: true,
            canExecute: false,
            reason: "reference is trusted",
          },
        }, {
          kind: "template",
          label: "finding.md",
          sourceInfo: { source: "file", label: "skills/review/templates/finding.md", scope: "project" },
          trustPolicy: {
            canRead: true,
            canInject: true,
            canExecute: false,
            reason: "template is trusted",
          },
          template: {
            name: "finding",
            description: "Finding template.",
            variableDefinitions: [{
              name: "target",
              description: "File or directory to review.",
            }],
          },
        }, {
          kind: "script",
          label: "collect.js",
          sourceInfo: { source: "file", label: "skills/review/scripts/collect.js", scope: "project" },
          trustPolicy: {
            canRead: false,
            canInject: false,
            canExecute: true,
            reason: "script can execute",
          },
          script: {
            execute: true,
            sandbox: "local",
            interpreter: "node",
            timeoutMs: 5000,
            outputLimitBytes: 1048576,
            args: [{
              name: "numbers",
              type: "number[]",
              required: true,
              description: "Numbers to sum.",
            }],
          },
        }],
        references: [{
          file: {
            kind: "reference",
            label: "checklist.md",
            path: "/tmp/checklist.md",
            sourceInfo: { source: "file", label: "skills/review/references/checklist.md", scope: "project" },
          },
          content: "Check regressions.",
        }],
        templates: [{
          name: "finding",
          content: "Finding for src/runtime.ts.",
          variables: {
            target: "src/runtime.ts",
          },
          sourceInfo: { source: "file", label: "skills/review/templates/finding.md", scope: "project" },
        }],
      },
    },
  });

  assert.deepEqual(context.promptMessages.map(readTextFromMessage), [
    [
      '<skill name="review" source="test">',
      "Report findings first.",
      "",
      "<available_support_files>",
      '<file kind="reference" label="checklist.md" source="skills/review/references/checklist.md" read="yes" inject="yes" execute="no" policy_reason="reference is trusted" />',
      '<file kind="template" label="finding.md" source="skills/review/templates/finding.md" read="yes" inject="yes" execute="no" policy_reason="template is trusted">',
      '<template_contract name="finding" description="Finding template." variables="target" />',
      "</file>",
      '<file kind="script" label="collect.js" source="skills/review/scripts/collect.js" read="no" inject="no" execute="yes" policy_reason="script can execute" sandbox="local" interpreter="node" timeout_ms="5000" output_limit_bytes="1048576">',
      '<arg name="numbers" type="number[]" required="yes" description="Numbers to sum." />',
      "</file>",
      "</available_support_files>",
      "",
      "<support_file_tools>",
      '<tool name="skill_read_support_file" action="read" />',
      '<tool name="skill_render_template" action="render" />',
      '<tool name="skill_run_script" action="run" />',
      "</support_file_tools>",
      "",
      "<references>",
      '<reference source="skills/review/references/checklist.md">',
      "Check regressions.",
      "</reference>",
      "</references>",
      "",
      "<templates>",
      '<template name="finding" source="skills/review/templates/finding.md">',
      "Finding for src/runtime.ts.",
      "</template>",
      "</templates>",
      "",
      "<arguments>",
      "src/runtime.ts",
      "</arguments>",
      "</skill>",
    ].join("\n"),
    "/skill use review src/runtime.ts",
  ]);
  assert.deepEqual(context.persistentPromptMessageIndexes, [1]);
  assert.deepEqual(context.transientPromptMessageIndexes, [0]);
});

test("ContextAssembler preserves rendered template when beforeRun adds messages", async () => {
  const assembler = new ContextAssembler({
    lifecycleRunner: createLifecycleRunner({
      beforeRun: [() => ({
        messages: [createUserMessage("run context")],
      })],
    }),
  });

  const context = await assembler.assemble({
    command: { type: "prompt", text: "/template review target=src/runtime.ts" },
    baseSystemPrompt: "base prompt",
    conversationMessages: [],
    metadata: {
      promptTemplate: {
        name: "review",
        content: "Review src/runtime.ts.",
        variables: {
          target: "src/runtime.ts",
        },
        sourceInfo: { source: "sdk", label: "test", scope: "explicit" },
      },
    },
  });

  assert.deepEqual(context.promptMessages.map(readTextFromMessage), [
    "run context",
    [
      '<prompt_template name="review" source="test">',
      "Review src/runtime.ts.",
      "</prompt_template>",
    ].join("\n"),
    "/template review target=src/runtime.ts",
  ]);
  assert.deepEqual(context.persistentPromptMessageIndexes, [2]);
  assert.deepEqual(context.transientPromptMessageIndexes, [0, 1]);
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
