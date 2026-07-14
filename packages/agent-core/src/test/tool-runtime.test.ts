import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "@earendil-works/pi-ai";
import {
  createToolRuntime,
  defineAgentTool,
  wrapToolWithRuntime,
  type AfterToolCallInput,
  type AgentToolDefinition
} from "../index.js";

const runtimeToolParameters = Type.Object({
  topic: Type.String()
});

test("ToolRuntime runs before and after hooks around successful tool execution", async () => {
  const calls: string[] = [];
  const tool = createRuntimeTool(async (_toolCallId, params) => {
    calls.push(`execute:${params.topic}`);
    return { content: [{ type: "text", text: `done:${params.topic}` }], details: { topic: params.topic } };
  });
  const runtime = createToolRuntime({
    beforeToolCall: [({ toolCallId }) => {
      calls.push(`before:${toolCallId}`);
    }],
    afterToolCall: [({ status, result }) => {
      calls.push(`after:${status}:${readText(result)}`);
    }]
  });

  const result = await runtime.execute({
    tool,
    toolCallId: "tool:runtime",
    args: { topic: "core" }
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.toolName, "runtime_tool");
  assert.equal(readText(result.result), "done:core");
  assert.deepEqual(calls, [
    "before:tool:runtime",
    "execute:core",
    "after:succeeded:done:core"
  ]);
});

test("ToolRuntime blocks execution when a before hook denies the call", async () => {
  let executed = false;
  const afterCalls: AfterToolCallInput[] = [];
  const tool = createRuntimeTool(async () => {
    executed = true;
    return { content: [{ type: "text", text: "should not run" }], details: {} };
  });
  const runtime = createToolRuntime({
    beforeToolCall: [() => ({ allow: false, reason: "policy denied" })],
    afterToolCall: [(input) => {
      afterCalls.push(input);
    }]
  });

  const result = await runtime.execute({
    tool,
    toolCallId: "tool:blocked",
    args: { topic: "core" }
  });

  assert.equal(executed, false);
  assert.equal(result.status, "blocked");
  assert.equal(result.error?.message, "policy denied");
  assert.equal(afterCalls[0]?.status, "blocked");
});

test("wrapped tools forward updates and throw normalized runtime failures", async () => {
  const updates: string[] = [];
  const tool = createRuntimeTool(async (_toolCallId, params, _signal, onUpdate) => {
    onUpdate?.({ content: [{ type: "text", text: `partial:${params.topic}` }], details: {} });
    return { content: [{ type: "text", text: `final:${params.topic}` }], details: {} };
  });
  const wrapped = wrapToolWithRuntime(tool, createToolRuntime());

  const result = await wrapped.execute("tool:wrapped", { topic: "core" }, undefined, (partialResult) => {
    updates.push(readText(partialResult));
  });

  assert.equal(readText(result), "final:core");
  assert.deepEqual(updates, ["partial:core"]);

  const blocked = wrapToolWithRuntime(tool, createToolRuntime({
    beforeToolCall: [() => false]
  }));
  await assert.rejects(
    () => blocked.execute("tool:wrapped-blocked", { topic: "core" }),
    /Tool call blocked/
  );
});

function createRuntimeTool(
  execute: AgentToolDefinition<typeof runtimeToolParameters, Record<string, unknown>>["execute"]
): AgentToolDefinition<typeof runtimeToolParameters, Record<string, unknown>> {
  return defineAgentTool({
    name: "runtime_tool",
    label: "Runtime Tool",
    description: "Exercise ToolRuntime.",
    promptSnippet: "Exercise ToolRuntime.",
    promptGuidelines: [],
    sourceInfo: { source: "sdk", label: "ToolRuntime Test" },
    parameters: runtimeToolParameters,
    execute
  });
}

function readText(result: unknown): string {
  if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content)) return "";
  return result.content.flatMap((block: unknown) => {
    if (!block || typeof block !== "object" || !("type" in block) || block.type !== "text") return [];
    return "text" in block && typeof block.text === "string" ? [block.text] : [];
  }).join("\n");
}
