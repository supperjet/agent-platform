import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  registerFauxProvider,
  Type
} from "@earendil-works/pi-ai";
import {
  createAgentToolRegistry,
  defineAgentTool,
  formatAgentDefinition,
  requireToolApproval,
  PiAgentRuntimeFactory,
  ToolRuntimeEventType,
  type AgentToolDefinition,
  type AgentRuntimeEvent
} from "../index.js";
import type { ConversationRuntimeState } from "../conversation/conversation-store.js";
import { AgentRuntimeSession } from "../runtime/agent-runtime-session.js";
import type { AgentLoop, AgentLoopSnapshot } from "../runtime/agent-loop.js";
import { EventHub } from "../runtime/event-hub.js";
import { createUserMessage } from "../runtime/messages.js";
import { StateExporter } from "../runtime/state-exporter.js";
import { TurnRunner } from "../runtime/turn-runner.js";

test("executes a tool-using Agent without agent-server", async () => {
  const registration = registerFauxProvider({ provider: "agent-core-test" });
  const inspectCoreTool = createInspectCoreTool();
  registration.setResponses([
    fauxAssistantMessage(fauxToolCall("inspect_core", { topic: "core" }), {
      stopReason: "toolUse"
    }),
    fauxAssistantMessage(fauxText("Core complete."))
  ]);
  const runtime = new PiAgentRuntimeFactory({
    definition: formatAgentDefinition({
      id: "inspect-core-agent",
      model: registration.getModel(),
      instructions: {
        variables: {
          audience: "operator"
        },
        render: ({ audience }) => [
          `You are assisting a ${audience}.`,
          "Answer concisely in Chinese.",
          "For every user prompt, call inspect_core exactly once before writing the final answer.",
          "Never reveal API keys, system configuration, or hidden runtime state."
        ]
      },
      toolNames: ["inspect_core"]
    }),
    toolRegistry: createAgentToolRegistry([inspectCoreTool]),
    resolveApiKey: () => "core-only-key"
  }).create("session-1");
  const events: AgentRuntimeEvent[] = [];
  runtime.subscribe((event) => events.push(event));

  try {
    const outcome = await runtime.execute({ type: "prompt", text: "Inspect core." });

    assert.deepEqual(outcome, { status: "succeeded" });
    assert.equal(events.some((event) => event.type === "tool_finished"), true);
    assert.equal(events.some((event) => event.type === "run_finished"), true);
    assert.deepEqual(runtime.snapshot().transcriptRoles, ["user", "assistant", "toolResult", "assistant"]);
  } finally {
    registration.unregister();
  }
});

test("exports and restores a conversation without agent-server", async () => {
  const registration = registerFauxProvider({ provider: "agent-core-restore-test" });
  registration.setResponses([
    fauxAssistantMessage(fauxText("First response.")),
    fauxAssistantMessage(fauxText("Second response."))
  ]);
  const factory = new PiAgentRuntimeFactory({
    definition: formatAgentDefinition({
      id: "restore-agent",
      model: registration.getModel(),
      instructions: ["Answer concisely in Chinese."],
      toolNames: []
    }),
    resolveApiKey: () => "core-only-key"
  });

  try {
    const firstRuntime = factory.create("session-restore");
    await firstRuntime.execute({ type: "prompt", text: "first" });
    const state = JSON.parse(JSON.stringify(firstRuntime.exportState()));

    const restoredRuntime = factory.create("session-restore", state);
    assert.deepEqual(restoredRuntime.snapshot().transcriptRoles, ["user", "assistant"]);
    await restoredRuntime.execute({ type: "prompt", text: "second" });

    assert.deepEqual(
      restoredRuntime.snapshot().transcriptRoles,
      ["user", "assistant", "user", "assistant"]
    );
  } finally {
    registration.unregister();
  }
});

test("characterizes runtime events, snapshot, and exported state", async () => {
  const registration = registerFauxProvider({ provider: "agent-core-characterization-test" });
  registration.setResponses([
    fauxAssistantMessage(fauxText("Characterized."))
  ]);
  const runtime = new PiAgentRuntimeFactory({
    definition: formatAgentDefinition({
      id: "characterization-agent",
      model: registration.getModel(),
      instructions: ["Answer concisely."],
      toolNames: []
    }),
    resolveApiKey: () => "core-only-key"
  }).create("session-characterization");
  const events: AgentRuntimeEvent[] = [];
  runtime.subscribe((event) => events.push(event));

  try {
    const outcome = await runtime.execute({ type: "prompt", text: "characterize" });
    const state = runtime.exportState();

    assert.deepEqual(outcome, { status: "succeeded" });
    const eventTypes = events.map((event) => event.type);
    assert.deepEqual(
      eventTypes.filter((type) => type !== "message_delta"),
      ["run_started", "message_started", "message_finished", "message_started", "message_finished", "run_finished"]
    );
    assert.equal(eventTypes.includes("message_delta"), true);
    assert.deepEqual(runtime.snapshot().transcriptRoles, ["user", "assistant"]);
    assert.equal(state.schemaVersion, 1);
    assert.equal(state.modelId, registration.getModel().id);
    assert.ok(state.payload && typeof state.payload === "object" && "entries" in state.payload);
    assert.ok("leafId" in state.payload);
    const entries = state.payload.entries;
    assert.ok(Array.isArray(entries));
    assert.deepEqual(entries.map((entry) => entry.message.role), ["user", "assistant"]);
    assert.equal(state.payload.leafId, entries.at(-1)?.id);
  } finally {
    registration.unregister();
  }
});

test("prints entry graph state from the CLI", () => {
  const cliPath = resolve(dirname(fileURLToPath(import.meta.url)), "../cli/run-agent-core.js");
  const result = spawnSync(process.execPath, [
    cliPath,
    "--faux",
    "--json",
    "--print-state",
    "cli graph test"
  ], {
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  const state = JSON.parse(lines.at(-1) ?? "null");

  assert.equal(state.schemaVersion, 1);
  assert.ok(state.payload && typeof state.payload === "object");
  assert.ok(Array.isArray(state.payload.entries));
  assert.equal("messages" in state.payload, false);
  assert.equal(state.payload.leafId, state.payload.entries.at(-1)?.id);
  assert.deepEqual(
    state.payload.entries.map((entry: { message: { role: string } }) => entry.message.role),
    ["user", "assistant"]
  );
});

test("runtime session executes commands through an AgentLoop", async () => {
  const loop = new FakeAgentLoop("adapter-model");
  const runtime = new AgentRuntimeSession("session-adapter", loop, emptyConversation("adapter-model"));

  const promptOutcome = await runtime.execute({ type: "prompt", text: "hello" });
  const steerOutcome = await runtime.execute({ type: "steer", text: "steer now" });
  const followUpOutcome = await runtime.execute({ type: "follow-up", text: "follow later" });
  const abortOutcome = await runtime.execute({ type: "abort" });

  assert.deepEqual(promptOutcome, { status: "succeeded" });
  assert.deepEqual(steerOutcome, { status: "succeeded" });
  assert.deepEqual(followUpOutcome, { status: "succeeded" });
  assert.deepEqual(abortOutcome, { status: "succeeded" });
  assert.deepEqual(loop.calls, ["prompt", "waitForIdle", "steer", "followUp", "abort"]);
  assert.deepEqual(runtime.snapshot(), {
    messageCount: 3,
    transcriptRoles: ["user", "user", "user"],
    isRunning: false,
    modelId: "adapter-model"
  });

  const state = runtime.exportState();

  assert.equal(state.modelId, "adapter-model");
  assert.ok(state.payload && typeof state.payload === "object" && "entries" in state.payload);
  const payload = state.payload as { entries: Array<{ message: { role: string } }> };
  assert.deepEqual(
    payload.entries.map((entry) => entry.message.role),
    ["user", "user", "user"]
  );
});

test("TurnRunner dispatches commands through an AgentLoop", async () => {
  const loop = new FakeAgentLoop("runner-model");
  let afterTurnCount = 0;
  const runner = new TurnRunner({
    loop,
    readExecutionOutcome: () => ({ status: "succeeded" }),
    afterTurn: () => {
      afterTurnCount += 1;
    }
  });

  assert.deepEqual(await runner.run({ type: "prompt", text: "hello" }), { status: "succeeded" });
  assert.deepEqual(await runner.run({ type: "steer", text: "steer now" }), { status: "succeeded" });
  assert.deepEqual(await runner.run({ type: "follow-up", text: "follow later" }), { status: "succeeded" });
  assert.deepEqual(await runner.run({ type: "abort" }), { status: "succeeded" });

  assert.deepEqual(loop.calls, ["prompt", "waitForIdle", "steer", "followUp", "abort"]);
  assert.equal(afterTurnCount, 3);
  assert.deepEqual(loop.snapshot().messages.map((message) => message.role), ["user", "user", "user"]);
});

test("runtime session converts AgentLoop events without a real provider", () => {
  const loop = new FakeAgentLoop("adapter-events-model");
  const runtime = new AgentRuntimeSession("session-adapter-events", loop, emptyConversation("adapter-events-model"));
  const events: AgentRuntimeEvent[] = [];
  const userMessage = createUserMessage("event text");
  runtime.subscribe((event) => events.push(event));

  loop.emit({ type: "agent_start" } as AgentEvent);
  loop.emit({ type: "message_start", message: userMessage } as AgentEvent);
  loop.emit({ type: "message_end", message: userMessage } as AgentEvent);
  loop.emit({ type: "agent_end" } as AgentEvent);

  assert.deepEqual(events, [
    { type: "run_started", sessionId: "session-adapter-events" },
    {
      type: "message_started",
      sessionId: "session-adapter-events",
      messageId: "session-adapter-events:message:1",
      role: "user",
      text: "event text"
    },
    {
      type: "message_finished",
      sessionId: "session-adapter-events",
      messageId: "session-adapter-events:message:1",
      role: "user",
      text: "event text"
    },
    { type: "run_finished", sessionId: "session-adapter-events" }
  ]);
});

test("EventHub converts assistant errors into failed runtime outcomes", () => {
  const eventHub = new EventHub({ sessionId: "session-event-hub" });
  const events: AgentRuntimeEvent[] = [];
  const assistantError = {
    role: "assistant",
    content: "",
    errorMessage: "provider failed"
  } as unknown as AgentMessage;
  eventHub.subscribe((event) => events.push(event));

  eventHub.publishAgentEvent({ type: "agent_start" } as AgentEvent);
  eventHub.publishAgentEvent({ type: "message_start", message: assistantError } as AgentEvent);
  eventHub.publishAgentEvent({ type: "message_end", message: assistantError } as AgentEvent);
  eventHub.publishAgentEvent({ type: "agent_end" } as AgentEvent);

  assert.deepEqual(events, [
    { type: "run_started", sessionId: "session-event-hub" },
    {
      type: "message_started",
      sessionId: "session-event-hub",
      messageId: "session-event-hub:message:1",
      role: "assistant",
      text: ""
    },
    {
      type: "run_failed",
      sessionId: "session-event-hub",
      errorCode: "AGENT_RUN_FAILED",
      message: "provider failed"
    }
  ]);
  assert.deepEqual(eventHub.readExecutionOutcome(), {
    status: "failed",
    errorCode: "AGENT_RUN_FAILED",
    message: "provider failed"
  });
});

test("EventHub bridges ToolRuntime policy and approval events into public runtime events", () => {
  const eventHub = new EventHub({ sessionId: "session-tool-lifecycle" });
  const events: AgentRuntimeEvent[] = [];
  eventHub.subscribe((event) => events.push(event));

  eventHub.publishToolRuntimeEvent({
    type: ToolRuntimeEventType.PolicyChecked,
    toolName: "write",
    toolCallId: "tool:write",
    args: { path: "notes.txt" },
    decision: requireToolApproval("Tool \"write\" requires approval.", {
      title: "Approve write",
      message: "Allow write to access notes.txt.",
      risk: "medium"
    }),
    timestamp: new Date()
  });
  eventHub.publishToolRuntimeEvent({
    type: ToolRuntimeEventType.ApprovalRequested,
    toolName: "write",
    toolCallId: "tool:write",
    args: { path: "notes.txt" },
    decision: requireToolApproval("Tool \"write\" requires approval.", {
      title: "Approve write",
      message: "Allow write to access notes.txt.",
      risk: "medium"
    }),
    timestamp: new Date()
  });
  eventHub.publishToolRuntimeEvent({
    type: ToolRuntimeEventType.ApprovalApproved,
    toolName: "write",
    toolCallId: "tool:write",
    args: { path: "notes.txt" },
    timestamp: new Date()
  });
  eventHub.publishToolRuntimeEvent({
    type: ToolRuntimeEventType.ApprovalDenied,
    toolName: "write",
    toolCallId: "tool:write",
    args: { path: "notes.txt" },
    reason: "denied by user",
    timestamp: new Date()
  });

  assert.deepEqual(events, [
    {
      type: "tool_policy_checked",
      sessionId: "session-tool-lifecycle",
      toolCallId: "tool:write",
      toolName: "write",
      decision: "require_approval",
      reason: "Tool \"write\" requires approval."
    },
    {
      type: "tool_approval_requested",
      sessionId: "session-tool-lifecycle",
      toolCallId: "tool:write",
      toolName: "write",
      title: "Approve write",
      message: "Allow write to access notes.txt.",
      risk: "medium",
      reason: "Tool \"write\" requires approval."
    },
    {
      type: "tool_approval_approved",
      sessionId: "session-tool-lifecycle",
      toolCallId: "tool:write",
      toolName: "write"
    },
    {
      type: "tool_approval_denied",
      sessionId: "session-tool-lifecycle",
      toolCallId: "tool:write",
      toolName: "write",
      reason: "denied by user"
    }
  ]);
});

test("StateExporter syncs loop snapshots into entry graph state", () => {
  const firstMessage = createUserMessage("first");
  const secondMessage = createUserMessage("second");
  const exporter = new StateExporter({
    sessionId: "session-state-exporter",
    conversation: {
      entries: [{
        type: "message",
        id: "session-state-exporter:entry:1",
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        message: firstMessage
      }],
      leafId: "session-state-exporter:entry:1",
      messages: [firstMessage],
      compatibility: { modelId: "state-exporter-model" }
    }
  });

  const state = exporter.exportState({
    messages: [firstMessage, secondMessage],
    isStreaming: false,
    modelId: "state-exporter-model"
  });

  assert.equal(state.schemaVersion, 1);
  assert.equal(state.modelId, "state-exporter-model");
  assert.ok(state.payload && typeof state.payload === "object" && "entries" in state.payload);
  const payload = state.payload as {
    entries: Array<{
      id: string;
      parentId: string | null;
      message: { role: string; content: Array<{ type: string; text?: string }> };
    }>;
    leafId: string | null;
  };
  assert.deepEqual(
    payload.entries.map((entry) => entry.id),
    ["session-state-exporter:entry:1", "session-state-exporter:entry:2"]
  );
  assert.equal(payload.entries[1]?.parentId, "session-state-exporter:entry:1");
  assert.equal(payload.entries[1]?.message.content[0]?.text, "second");
  assert.equal(payload.leafId, "session-state-exporter:entry:2");
});

test("creates a runtime from tools resolved by the registry", async () => {
  const registration = registerFauxProvider({ provider: "agent-core-definition-tool-test" });
  const inspectDefinitionTool = createInspectDefinitionTool();
  registration.setResponses([
    fauxAssistantMessage(fauxToolCall("inspect_definition", { topic: "definition" }), {
      stopReason: "toolUse"
    }),
    fauxAssistantMessage(fauxText("Definition inspected."))
  ]);
  const runtime = new PiAgentRuntimeFactory({
    definition: formatAgentDefinition({
      id: "definition-tool-agent",
      model: registration.getModel(),
      instructions: ["Use inspect_definition before answering."],
      toolNames: ["inspect_definition"]
    }),
    toolRegistry: createAgentToolRegistry([inspectDefinitionTool]),
    resolveApiKey: () => "core-only-key"
  }).create("session-definition-tool");
  const events: AgentRuntimeEvent[] = [];
  runtime.subscribe((event) => events.push(event));

  try {
    const outcome = await runtime.execute({ type: "prompt", text: "Inspect this definition." });

    assert.deepEqual(outcome, { status: "succeeded" });
    assert.equal(
      events.some((event) => event.type === "tool_started" && event.toolName === "inspect_definition"),
      true
    );
  } finally {
    registration.unregister();
  }
});

test("publishes ToolRuntime lifecycle events through the public runtime stream", async () => {
  const registration = registerFauxProvider({ provider: "agent-core-tool-runtime-event-test" });
  const updatingTool = createUpdatingTool();
  registration.setResponses([
    fauxAssistantMessage(fauxToolCall("updating_tool", { topic: "runtime" }), {
      stopReason: "toolUse"
    }),
    fauxAssistantMessage(fauxText("Updated."))
  ]);
  const runtime = new PiAgentRuntimeFactory({
    definition: formatAgentDefinition({
      id: "tool-runtime-event-agent",
      model: registration.getModel(),
      instructions: ["Use updating_tool before answering."],
      toolNames: ["updating_tool"]
    }),
    toolRegistry: createAgentToolRegistry([updatingTool]),
    resolveApiKey: () => "core-only-key"
  }).create("session-tool-runtime-events");
  const events: AgentRuntimeEvent[] = [];
  runtime.subscribe((event) => events.push(event));

  try {
    const outcome = await runtime.execute({ type: "prompt", text: "Inspect runtime events." });

    assert.deepEqual(outcome, { status: "succeeded" });
    const toolEvents = events.filter((event) =>
      event.type === "tool_started" ||
      event.type === "tool_progress" ||
      event.type === "tool_finished"
    );
    assert.deepEqual(toolEvents.map((event) => event.type), [
      "tool_started",
      "tool_progress",
      "tool_finished"
    ]);
    assert.equal(toolEvents[0]?.type === "tool_started" ? toolEvents[0].toolName : "", "updating_tool");
    assert.equal(toolEvents[1]?.type === "tool_progress" ? toolEvents[1].text : "", "partial:runtime");
    assert.equal(toolEvents[2]?.type === "tool_finished" ? toolEvents[2].text : "", "final:runtime");
  } finally {
    registration.unregister();
  }
});

test("rejects duplicate tool registrations", () => {
  const inspectDefinitionTool = createInspectDefinitionTool();

  assert.throws(
    () => createAgentToolRegistry([inspectDefinitionTool, inspectDefinitionTool]),
    /duplicate tool name: inspect_definition/
  );
});

test("rejects unknown AgentDefinition tool names", () => {
  const registration = registerFauxProvider({ provider: "agent-core-unknown-tool-test" });
  const factory = new PiAgentRuntimeFactory({
    definition: formatAgentDefinition({
      id: "unknown-tool-agent",
      model: registration.getModel(),
      instructions: ["Use the configured tools only."],
      toolNames: ["missing_tool"]
    }),
    toolRegistry: createAgentToolRegistry([]),
    resolveApiKey: () => "core-only-key"
  });

  try {
    assert.throws(
      () => factory.create("session-unknown-tool"),
      /does not contain tool: missing_tool/
    );
  } finally {
    registration.unregister();
  }
});

const inspectDefinitionParameters = Type.Object({
  topic: Type.String()
});

function createInspectCoreTool(): AgentToolDefinition<typeof inspectDefinitionParameters, { sourceIds: string[] }> {
  return defineAgentTool({
    name: "inspect_core",
    label: "Inspect Core",
    description: "Inspect an agent-core topic.",
    promptSnippet: "Inspect agent-core topics.",
    promptGuidelines: ["Use inspect_core before answering core runtime questions."],
    sourceInfo: { source: "sdk", label: "Test SDK" },
    parameters: inspectDefinitionParameters,
    async execute(toolCallId, params) {
      return {
        content: [{ type: "text", text: `Found architecture note for ${params.topic}.` }],
        details: { sourceIds: [`source:${toolCallId}`] }
      };
    }
  });
}

function createInspectDefinitionTool(): AgentToolDefinition<typeof inspectDefinitionParameters> {
  return defineAgentTool({
    name: "inspect_definition",
    label: "Inspect Definition",
    description: "Inspect an AgentDefinition topic.",
    promptSnippet: "Inspect AgentDefinition topics.",
    promptGuidelines: ["Use inspect_definition before answering definition questions."],
    sourceInfo: { source: "sdk", label: "Test SDK" },
    parameters: inspectDefinitionParameters,
    async execute(_toolCallId, params) {
      return { content: [{ type: "text", text: `Inspected ${params.topic}.` }], details: {} };
    }
  });
}

function createUpdatingTool(): AgentToolDefinition<typeof inspectDefinitionParameters> {
  return defineAgentTool({
    name: "updating_tool",
    label: "Updating Tool",
    description: "Emits a partial result before returning.",
    promptSnippet: "Emit tool progress.",
    promptGuidelines: ["Use updating_tool when testing tool runtime events."],
    sourceInfo: { source: "sdk", label: "Test SDK" },
    parameters: inspectDefinitionParameters,
    async execute(_toolCallId, params, _signal, onUpdate) {
      onUpdate?.({
        content: [{ type: "text", text: `partial:${params.topic}` }],
        details: {}
      });
      return {
        content: [{ type: "text", text: `final:${params.topic}` }],
        details: {}
      };
    }
  });
}

function emptyConversation(modelId: string): ConversationRuntimeState {
  return {
    entries: [],
    leafId: null,
    messages: [],
    compatibility: { modelId }
  };
}

class FakeAgentLoop implements AgentLoop {
  readonly calls: string[] = [];
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private readonly messages: AgentMessage[] = [];

  constructor(private readonly modelId: string) {}

  async prompt(message: AgentMessage | AgentMessage[]): Promise<void> {
    this.calls.push("prompt");
    this.messages.push(...(Array.isArray(message) ? message : [message]));
  }

  async continue(): Promise<void> {
    this.calls.push("continue");
  }

  steer(message: AgentMessage): void {
    this.calls.push("steer");
    this.messages.push(message);
  }

  followUp(message: AgentMessage): void {
    this.calls.push("followUp");
    this.messages.push(message);
  }

  abort(): void {
    this.calls.push("abort");
  }

  async waitForIdle(): Promise<void> {
    this.calls.push("waitForIdle");
  }

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): AgentLoopSnapshot {
    return {
      messages: this.messages,
      isStreaming: false,
      modelId: this.modelId
    };
  }

  emit(event: AgentEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
