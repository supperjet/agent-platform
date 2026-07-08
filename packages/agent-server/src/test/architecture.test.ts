import assert from "node:assert/strict";
import test from "node:test";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  registerFauxProvider
} from "@earendil-works/pi-ai";
import { createApplication } from "../bootstrap.js";

test("isolates sessions and publishes projected event history", async () => {
  const provider = "agent-server-test";
  const registration = registerFauxProvider({ provider });
  registration.setResponses([
    fauxAssistantMessage(fauxToolCall("lookup_source", { topic: "alpha" }, { id: "alpha-source" }), {
      stopReason: "toolUse"
    }),
    fauxAssistantMessage(fauxText("Alpha complete.")),
    fauxAssistantMessage(fauxToolCall("lookup_source", { topic: "beta" }, { id: "beta-source" }), {
      stopReason: "toolUse"
    }),
    fauxAssistantMessage(fauxText("Beta complete."))
  ]);

  const application = await createApplication({
    storageMode: "inMemory",
    runtime: {
      model: registration.getModel(),
      resolveApiKey: (requestedProvider) => requestedProvider === provider ? "server-only-key" : undefined
    }
  });

  try {
    const alpha = await application.app.inject({
      method: "POST",
      url: "/api/v1/sessions/session-alpha/commands",
      payload: { commandId: "alpha-command", type: "prompt", text: "Inspect alpha." }
    });
    const beta = await application.app.inject({
      method: "POST",
      url: "/api/v1/sessions/session-beta/commands",
      payload: { commandId: "beta-command", type: "prompt", text: "Inspect beta." }
    });
    await application.sessionApplication.close();
    const history = await application.app.inject({
      method: "GET",
      url: "/api/v1/sessions/session-alpha/events"
    });

    assert.equal(alpha.statusCode, 202);
    assert.equal(beta.statusCode, 202);
    assert.equal(history.statusCode, 200);
    assert.equal(history.body.includes("server-only-key"), false);
    assert.equal((await application.sessionManager.snapshot("session-alpha"))?.messageCount, 4);
    assert.equal((await application.sessionManager.snapshot("session-beta"))?.messageCount, 4);
  } finally {
    await application.app.close();
    registration.unregister();
  }
});

test("validates commands before creating a runtime", async () => {
  const registration = registerFauxProvider();
  const application = await createApplication({
    storageMode: "inMemory",
    runtime: { model: registration.getModel(), resolveApiKey: () => "test-key" }
  });

  try {
    const response = await application.app.inject({
      method: "POST",
      url: "/api/v1/sessions/invalid/commands",
      payload: {}
    });

    assert.equal(response.statusCode, 400);
    assert.equal(await application.sessionManager.snapshot("invalid"), undefined);
  } finally {
    await application.app.close();
    registration.unregister();
  }
});

test("publishes provider failures instead of an empty successful run", async () => {
  const logEntries: Array<{ level: string; event: string; [key: string]: unknown }> = [];
  const registration = registerFauxProvider();
  registration.setResponses([
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "Provider unavailable" })
  ]);
  const application = await createApplication({
    storageMode: "inMemory",
    runtime: { model: registration.getModel(), resolveApiKey: () => "test-key" },
    executionLogger: {
      log: (level, entry) => logEntries.push({ level, ...entry })
    }
  });

  try {
    await application.app.inject({
      method: "POST",
      url: "/api/v1/sessions/failing-session/commands",
      payload: { commandId: "failing-command", type: "prompt", text: "hello" }
    });
    await application.sessionApplication.close();
    const history = await application.app.inject({
      method: "GET",
      url: "/api/v1/sessions/failing-session/events"
    });
    const command = await application.sessionApplication.getCommand("failing-command");
    const events = history.json().events as Array<{ type: string; payload: { message?: string } }>;

    assert.equal(command?.status, "failed");
    assert.equal(events.some((event) => event.type === "run_failed"), true);
    assert.equal(events.some((event) => event.type === "run_finished"), false);
    assert.equal(events.find((event) => event.type === "run_failed")?.payload.message, "Provider unavailable");
    assert.deepEqual(
      logEntries.find((entry) => entry.event === "command.execution.failed"),
      {
        level: "error",
        event: "command.execution.failed",
        commandId: "failing-command",
        sessionId: "failing-session",
        commandType: "prompt",
        status: "failed",
        errorCode: "AGENT_RUN_FAILED",
        errorMessage: "Provider unavailable"
      }
    );
    assert.equal(JSON.stringify(logEntries).includes("hello"), false);
  } finally {
    await application.app.close();
    registration.unregister();
  }
});

test("reports composition milestones when an assembly reporter is configured", async () => {
  const registration = registerFauxProvider();
  const messages: string[] = [];
  const application = await createApplication({
    storageMode: "inMemory",
    runtime: { model: registration.getModel(), resolveApiKey: () => "test-key" },
    reportAssembly: (message) => messages.push(message)
  });

  try {
    assert.equal(messages.includes("PublicEventStream 装配成功（inMemory）"), true);
    assert.equal(messages.includes("CommandRunner 装配成功"), true);
    assert.equal(messages.includes(
      "ExecutionDispatcher 装配成功（InProcessExecutionDispatcher）"
    ), true);
    assert.equal(messages.includes("Fastify HTTP/SSE Adapter 装配成功"), true);
  } finally {
    await application.app.close();
    registration.unregister();
  }
});
