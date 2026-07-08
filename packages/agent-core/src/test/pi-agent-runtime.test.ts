import assert from "node:assert/strict";
import test from "node:test";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  registerFauxProvider
} from "@earendil-works/pi-ai";
import { PiAgentRuntimeFactory, type AgentRuntimeEvent } from "../index.js";

test("executes a tool-using Agent without agent-server", async () => {
  const registration = registerFauxProvider({ provider: "agent-core-test" });
  registration.setResponses([
    fauxAssistantMessage(fauxToolCall("lookup_source", { topic: "core" }), {
      stopReason: "toolUse"
    }),
    fauxAssistantMessage(fauxText("Core complete."))
  ]);
  const runtime = new PiAgentRuntimeFactory({
    model: registration.getModel(),
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
    model: registration.getModel(),
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
