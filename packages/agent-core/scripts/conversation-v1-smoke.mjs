#!/usr/bin/env node

import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fauxAssistantMessage, fauxText, registerFauxProvider } from "@earendil-works/pi-ai";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptDir, "..");
const workspaceRoot = resolve(packageRoot, "../..");

const { spawnSync } = await import("node:child_process");
run("npm", ["run", "build", "--workspace", "@agent-platform/agent-core"], workspaceRoot);

const core = await import(pathToFileURL(resolve(packageRoot, "dist/index.js")).href);
const { ConversationStore } = await import(
  pathToFileURL(resolve(packageRoot, "dist/conversation/conversation-store.js")).href
);
const registration = registerFauxProvider({ provider: "agent-core-smoke-faux" });
registration.setResponses([fauxAssistantMessage(fauxText("conversation smoke response"))]);

try {
  const model = registration.getModel();
  const definition = core.formatAgentDefinition({
    id: "conversation-v1-smoke",
    model,
    instructions: ["Smoke test conversation state export."],
    toolNames: [],
    resourceNames: []
  });
  const runtime = new core.PiAgentRuntimeFactory({
    definition,
    resolveApiKey: () => "faux-key"
  }).create("conversation-v1-smoke");

  const outcome = await runtime.execute({ type: "prompt", text: "conversation v1 smoke" });
  assert.deepEqual(outcome, { status: "succeeded" });

  const state = runtime.exportState();
  const payload = assertEntryGraphPayload(state.payload);

  assert.equal(state.schemaVersion, 2);
  assert.equal(typeof state.modelId, "string");
  assert.equal("messages" in payload, false);
  assert.equal(payload.entries.length >= 2, true);
  assert.equal(payload.leafId, payload.entries.at(-1)?.id);
  assert.deepEqual(
    payload.entries.map((entry) => readEntryMessage(entry).role),
    ["user", "assistant"]
  );

  const snapshot = new ConversationStore().restore({
    state,
    modelId: state.modelId,
    definitionId: "conversation-v1-smoke"
  });

  assert.equal(snapshot.leafId, payload.leafId);
  assert.equal(snapshot.entries.length, payload.entries.length);
  assert.deepEqual(
    snapshot.messages.map((message) => message.role),
    payload.entries.map((entry) => readEntryMessage(entry).role)
  );
  assert.deepEqual(snapshot.compatibility, {
    modelId: state.modelId,
    definitionId: "conversation-v1-smoke"
  });

  console.log(`conversation v1 smoke passed: ${payload.entries.length} entries, leafId=${payload.leafId}`);
} finally {
  registration.unregister();
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    throw new Error(`${command} ${args.join(" ")} failed with status ${result.status}`);
  }
}

function assertEntryGraphPayload(payload) {
  assert.equal(Boolean(payload && typeof payload === "object"), true);
  assert.equal("entries" in payload, true);
  assert.equal("leafId" in payload, true);
  assert.equal(Array.isArray(payload.entries), true);
  assert.equal(payload.leafId === null || typeof payload.leafId === "string", true);

  const ids = new Set();
  for (const entry of payload.entries) {
    assert.equal(entry.kind, "message");
    assert.equal(typeof entry.id, "string");
    assert.equal(entry.id.length > 0, true);
    assert.equal(entry.parentId === null || typeof entry.parentId === "string", true);
    assert.equal(typeof entry.createdAt, "string");
    assert.equal(Boolean(readEntryMessage(entry)), true);
    assert.equal(typeof readEntryMessage(entry).role, "string");
    assert.equal(ids.has(entry.id), false);
    ids.add(entry.id);
  }
  if (payload.leafId !== null) assert.equal(ids.has(payload.leafId), true);
  return payload;
}

function readEntryMessage(entry) {
  if (entry.message && typeof entry.message === "object") return entry.message;
  if (entry.payload?.message && typeof entry.payload.message === "object") return entry.payload.message;
  return undefined;
}
