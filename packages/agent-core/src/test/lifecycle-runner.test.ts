import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "@earendil-works/pi-ai";
import {
  createLifecycleRunner,
  defineAgentTool,
  type AgentToolDefinition,
} from "../index.js";

const lifecycleToolParameters = Type.Object({
  topic: Type.String(),
});

test("LifecycleRunner chains beforeToolCall argument transforms in registration order", async () => {
  const calls: string[] = [];
  const runner = createLifecycleRunner({
    beforeToolCall: [
      ({ args }) => {
        calls.push(readTopic(args));
        return { args: { topic: "first" } };
      },
      ({ args }) => {
        calls.push(readTopic(args));
        return { args: { topic: "second" } };
      },
    ],
  });

  const result = await runner.beforeToolCall({
    tool: createLifecycleTool(),
    toolCallId: "tool:lifecycle",
    args: { topic: "initial" },
  });

  assert.deepEqual(calls, ["initial", "first"]);
  assert.deepEqual(result, {
    status: "allowed",
    args: { topic: "second" },
  });
});

test("LifecycleRunner short-circuits beforeToolCall when a hook blocks", async () => {
  const calls: string[] = [];
  const runner = createLifecycleRunner({
    beforeToolCall: [
      () => {
        calls.push("first");
        return { allow: false, reason: "blocked by lifecycle" };
      },
      () => {
        calls.push("second");
      },
    ],
  });

  const result = await runner.beforeToolCall({
    tool: createLifecycleTool(),
    toolCallId: "tool:lifecycle-blocked",
    args: { topic: "initial" },
  });

  assert.deepEqual(calls, ["first"]);
  assert.deepEqual(result, {
    status: "blocked",
    reason: "blocked by lifecycle",
  });
});

test("LifecycleRunner chains afterToolCall result transforms", async () => {
  const runner = createLifecycleRunner({
    afterToolCall: [
      () => ({
        result: {
          content: [{ type: "text", text: "first" }],
          details: { topic: "first" },
        },
      }),
      ({ result }) => ({
        result: {
          content: [{ type: "text", text: `${readText(result)}:second` }],
          details: { topic: "second" },
        },
      }),
    ],
  });

  const result = await runner.afterToolCall({
    tool: createLifecycleTool(),
    toolCallId: "tool:lifecycle-after",
    args: { topic: "initial" },
    status: "succeeded",
    result: {
      content: [{ type: "text", text: "initial" }],
      details: { topic: "initial" },
    },
  });

  assert.equal(readText(result?.result), "first:second");
});

test("LifecycleRunner shallow merges metadata across hook chains", async () => {
  const runner = createLifecycleRunner({
    beforeRun: [
      () => ({ metadata: { command: "review", source: "first" } }),
      ({ metadata }) => ({
        metadata: {
          source: "second",
          seenCommand: metadata?.command,
        },
      }),
    ],
    beforeContext: [
      ({ metadata }) => ({
        metadata: {
          context: true,
          seenSource: metadata?.source,
        },
      }),
    ],
  });

  const beforeRun = await runner.beforeRun({
    command: { type: "prompt", text: "hello" },
    systemPrompt: "base",
  });
  const beforeContext = await runner.beforeContext({
    systemPrompt: "base",
    messages: [],
    ...(beforeRun?.metadata ? { metadata: beforeRun.metadata } : {}),
  });

  assert.deepEqual(beforeRun?.metadata, {
    command: "review",
    source: "second",
    seenCommand: "review",
  });
  assert.deepEqual(beforeContext?.metadata, {
    command: "review",
    source: "second",
    seenCommand: "review",
    context: true,
    seenSource: "second",
  });
});

function createLifecycleTool(): AgentToolDefinition<
  typeof lifecycleToolParameters,
  Record<string, unknown>
> {
  return defineAgentTool({
    name: "lifecycle_tool",
    label: "Lifecycle Tool",
    description: "Exercise LifecycleRunner.",
    promptSnippet: "Exercise LifecycleRunner.",
    promptGuidelines: [],
    sourceInfo: { source: "sdk", label: "LifecycleRunner Test" },
    parameters: lifecycleToolParameters,
    execute: async () => ({
      content: [{ type: "text", text: "done" }],
      details: {},
    }),
  });
}

function readTopic(args: unknown): string {
  if (!args || typeof args !== "object" || !("topic" in args)) return "";
  return typeof args.topic === "string" ? args.topic : "";
}

function readText(result: unknown): string {
  if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content)) return "";
  return result.content.flatMap((block: unknown) => {
    if (!block || typeof block !== "object" || !("type" in block) || block.type !== "text") return [];
    return "text" in block && typeof block.text === "string" ? [block.text] : [];
  }).join("\n");
}
