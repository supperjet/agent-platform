import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "@earendil-works/pi-ai";
import {
  createToolRuntime,
  createLifecycleRunner,
  blockTool,
  createDefaultToolPolicy,
  defineAgentTool,
  requireToolApproval,
  rewriteToolArgs,
  wrapToolWithRuntime,
  type AfterToolCallHookInput,
  type AgentToolDefinition,
  ToolRuntimeEventType,
  type ToolRuntimeEvent
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
    lifecycleRunner: createLifecycleRunner({
      beforeToolCall: [({ toolCallId }) => {
        calls.push(`before:${toolCallId}`);
      }],
      afterToolCall: [({ status, result }) => {
        calls.push(`after:${status}:${readText(result)}`);
      }]
    })
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
  const afterCalls: AfterToolCallHookInput[] = [];
  const tool = createRuntimeTool(async () => {
    executed = true;
    return { content: [{ type: "text", text: "should not run" }], details: {} };
  });
  const runtime = createToolRuntime({
    lifecycleRunner: createLifecycleRunner({
      beforeToolCall: [() => ({ allow: false, reason: "policy denied" })],
      afterToolCall: [(input) => {
        afterCalls.push(input);
      }]
    })
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

test("ToolRuntime emits lifecycle events and wraps tool updates", async () => {
  const events: ToolRuntimeEvent[] = [];
  const updates: string[] = [];
  const tool = createRuntimeTool(async (_toolCallId, params, _signal, onUpdate) => {
    onUpdate?.({ content: [{ type: "text", text: `partial:${params.topic}` }], details: {} });
    return { content: [{ type: "text", text: `final:${params.topic}` }], details: {} };
  });
  const runtime = createToolRuntime({
    onEvent: (event) => {
      events.push(event);
    }
  });

  const result = await runtime.execute({
    tool,
    toolCallId: "tool:events",
    args: { topic: "core" },
    onUpdate: (partialResult) => {
      updates.push(readText(partialResult));
    },
    context: { sessionId: "session:events", definitionId: "definition:events" }
  });

  assert.equal(result.status, "succeeded");
  assert.deepEqual(events.map((event) => event.type), [
    ToolRuntimeEventType.Started,
    ToolRuntimeEventType.Updated,
    ToolRuntimeEventType.Finished
  ]);
  assert.equal(events[0]?.toolName, "runtime_tool");
  assert.deepEqual(events[0]?.context, {
    sessionId: "session:events",
    definitionId: "definition:events"
  });
  assert.equal(
    events[1]?.type === ToolRuntimeEventType.Updated ? readText(events[1].result) : "",
    "partial:core"
  );
  assert.equal(
    events[2]?.type === ToolRuntimeEventType.Finished ? events[2].status : "",
    "succeeded"
  );
  assert.equal(
    events[2]?.type === ToolRuntimeEventType.Finished ? readText(events[2].result) : "",
    "final:core"
  );
  assert.deepEqual(updates, ["partial:core"]);
});

test("ToolRuntime emits terminal events for blocked and failed calls", async () => {
  const blockedEvents: ToolRuntimeEvent[] = [];
  const blockedTool = createRuntimeTool(async () => {
    return { content: [{ type: "text", text: "should not run" }], details: {} };
  });
  const blockedRuntime = createToolRuntime({
    lifecycleRunner: createLifecycleRunner({
      beforeToolCall: [() => ({ allow: false, reason: "policy denied" })]
    }),
    onEvent: (event) => {
      blockedEvents.push(event);
    }
  });

  const blockedResult = await blockedRuntime.execute({
    tool: blockedTool,
    toolCallId: "tool:blocked-event",
    args: { topic: "core" }
  });

  assert.equal(blockedResult.status, "blocked");
  assert.deepEqual(blockedEvents.map((event) => event.type), [
    ToolRuntimeEventType.Started,
    ToolRuntimeEventType.Finished
  ]);
  assert.equal(
    blockedEvents[1]?.type === ToolRuntimeEventType.Finished ? blockedEvents[1].status : "",
    "blocked"
  );
  assert.equal(
    blockedEvents[1]?.type === ToolRuntimeEventType.Finished ? blockedEvents[1].error?.message : "",
    "policy denied"
  );

  const failedEvents: ToolRuntimeEvent[] = [];
  const failedTool = createRuntimeTool(async () => {
    throw new Error("boom");
  });
  const failedRuntime = createToolRuntime({
    onEvent: (event) => {
      failedEvents.push(event);
    }
  });

  const failedResult = await failedRuntime.execute({
    tool: failedTool,
    toolCallId: "tool:failed-event",
    args: { topic: "core" }
  });

  assert.equal(failedResult.status, "failed");
  assert.deepEqual(failedEvents.map((event) => event.type), [
    ToolRuntimeEventType.Started,
    ToolRuntimeEventType.Finished
  ]);
  assert.equal(
    failedEvents[1]?.type === ToolRuntimeEventType.Finished ? failedEvents[1].status : "",
    "failed"
  );
  assert.equal(
    failedEvents[1]?.type === ToolRuntimeEventType.Finished ? failedEvents[1].error?.message : "",
    "boom"
  );
});

test("ToolRuntime blocks execution when ToolPolicy blocks the call", async () => {
  let executed = false;
  const events: ToolRuntimeEvent[] = [];
  const tool = createRuntimeTool(async () => {
    executed = true;
    return { content: [{ type: "text", text: "should not run" }], details: {} };
  });
  const runtime = createToolRuntime({
    policy: {
      decide: () => blockTool("policy blocked", "test_blocked")
    },
    onEvent: (event) => {
      events.push(event);
    }
  });

  const result = await runtime.execute({
    tool,
    toolCallId: "tool:policy-blocked",
    args: { topic: "core" }
  });

  assert.equal(executed, false);
  assert.equal(result.status, "blocked");
  assert.equal(result.error?.message, "policy blocked");
  assert.deepEqual(events.map((event) => event.type), [
    ToolRuntimeEventType.Started,
    ToolRuntimeEventType.PolicyChecked,
    ToolRuntimeEventType.Finished
  ]);
});

test("ToolRuntime executes with rewritten args returned by ToolPolicy", async () => {
  const tool = createRuntimeTool(async (_toolCallId, params) => {
    return { content: [{ type: "text", text: `done:${params.topic}` }], details: { topic: params.topic } };
  });
  const runtime = createToolRuntime({
    policy: {
      decide: () => rewriteToolArgs({ topic: "rewritten" }, "normalize input")
    }
  });

  const result = await runtime.execute({
    tool,
    toolCallId: "tool:policy-rewrite",
    args: { topic: "original" }
  });

  assert.equal(result.status, "succeeded");
  assert.equal(readText(result.result), "done:rewritten");
});

test("ToolRuntime resolves approval requests through the approval handler", async () => {
  const approvedEvents: ToolRuntimeEvent[] = [];
  const deniedEvents: ToolRuntimeEvent[] = [];
  const tool = createRuntimeTool(async (_toolCallId, params) => {
    return { content: [{ type: "text", text: `done:${params.topic}` }], details: {} };
  });
  const approvalPolicy = {
    decide: () => requireToolApproval("needs approval", {
      title: "Approve test tool",
      message: "Allow test tool.",
      risk: "medium"
    })
  };

  const approvedRuntime = createToolRuntime({
    policy: approvalPolicy,
    approvalHandler: async (input) => {
      assert.equal(input.approval.title, "Approve test tool");
      return true;
    },
    onEvent: (event) => {
      approvedEvents.push(event);
    }
  });
  const approvedResult = await approvedRuntime.execute({
    tool,
    toolCallId: "tool:approved",
    args: { topic: "approved" }
  });

  assert.equal(approvedResult.status, "succeeded");
  assert.equal(readText(approvedResult.result), "done:approved");
  assert.deepEqual(approvedEvents.map((event) => event.type), [
    ToolRuntimeEventType.Started,
    ToolRuntimeEventType.PolicyChecked,
    ToolRuntimeEventType.ApprovalRequested,
    ToolRuntimeEventType.ApprovalApproved,
    ToolRuntimeEventType.Finished
  ]);

  const deniedRuntime = createToolRuntime({
    policy: approvalPolicy,
    approvalHandler: () => false,
    onEvent: (event) => {
      deniedEvents.push(event);
    }
  });
  const deniedResult = await deniedRuntime.execute({
    tool,
    toolCallId: "tool:denied",
    args: { topic: "denied" }
  });

  assert.equal(deniedResult.status, "blocked");
  assert.equal(deniedResult.error?.message, "needs approval");
  assert.deepEqual(deniedEvents.map((event) => event.type), [
    ToolRuntimeEventType.Started,
    ToolRuntimeEventType.PolicyChecked,
    ToolRuntimeEventType.ApprovalRequested,
    ToolRuntimeEventType.ApprovalDenied,
    ToolRuntimeEventType.Finished
  ]);
});

test("default ToolPolicy requires approval for mutation tools and blocks risky paths or commands", async () => {
  const policy = createDefaultToolPolicy();

  assert.equal((await policy.decide({
    toolName: "read",
    toolCallId: "tool:read",
    args: { path: "src/index.ts" }
  })).type, "allow");

  const writeDecision = await policy.decide({
    toolName: "write",
    toolCallId: "tool:write",
    args: { path: "notes/todo.txt", content: "hello" }
  });
  assert.equal(writeDecision.type, "require_approval");

  const envDecision = await policy.decide({
    toolName: "read",
    toolCallId: "tool:env",
    args: { path: ".env" }
  });
  assert.equal(envDecision.type, "block");

  const bashDecision = await policy.decide({
    toolName: "bash",
    toolCallId: "tool:bash",
    args: { command: "git reset --hard HEAD" }
  });
  assert.equal(bashDecision.type, "block");
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
    lifecycleRunner: createLifecycleRunner({
      beforeToolCall: [() => false]
    })
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
