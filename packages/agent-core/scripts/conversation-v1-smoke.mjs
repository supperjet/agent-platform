#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptDir, "..");
const workspaceRoot = resolve(packageRoot, "../..");

run("npm", ["run", "build", "--workspace", "@agent-platform/agent-core"], workspaceRoot);

const stateFile = resolve(tmpdir(), "agent-core-conversation-v1-smoke-state.json");
const cliPath = resolve(packageRoot, "dist/cli/agent/index.js");
run(process.execPath, [
  cliPath,
  "--faux",
  "--playground-state-file",
  stateFile
], workspaceRoot, [
  "conversation v1 smoke",
  "/exit",
  ""
].join("\n"));

const state = JSON.parse(readFileSync(stateFile, "utf8")).agentState;
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

const { ConversationStore } = await import(
  pathToFileURL(resolve(packageRoot, "dist/conversation/conversation-store.js")).href
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

function run(command, args, cwd, input) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    input
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    throw new Error(`${command} ${args.join(" ")} failed with status ${result.status}`);
  }
  return result;
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
