#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptDir, "..");
const workspaceRoot = resolve(packageRoot, "../..");

run("npm", ["run", "build", "--workspace", "@agent-platform/agent-core"], workspaceRoot);

const cliPath = resolve(packageRoot, "dist/cli/run-agent-core.js");
const cli = run(process.execPath, [
  cliPath,
  "--faux",
  "--json",
  "--print-state",
  "conversation v1 smoke"
], workspaceRoot);

const state = readLastConversationState(cli.stdout);
const payload = assertEntryGraphPayload(state.payload);

assert.equal(state.schemaVersion, 1);
assert.equal(typeof state.modelId, "string");
assert.equal("messages" in payload, false);
assert.equal(payload.entries.length >= 2, true);
assert.equal(payload.leafId, payload.entries.at(-1)?.id);
assert.deepEqual(
  payload.entries.map((entry) => entry.message.role),
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
  payload.entries.map((entry) => entry.message.role)
);
assert.deepEqual(snapshot.compatibility, {
  modelId: state.modelId,
  definitionId: "conversation-v1-smoke"
});

console.log(`conversation v1 smoke passed: ${payload.entries.length} entries, leafId=${payload.leafId}`);

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
  return result;
}

function readLastConversationState(stdout) {
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  for (const line of lines.toReversed()) {
    const parsed = parseJson(line);
    if (isConversationState(parsed)) return parsed;
  }
  throw new Error("CLI output did not contain an AgentConversationState JSON line.");
}

function parseJson(line) {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function isConversationState(value) {
  return Boolean(
    value
      && typeof value === "object"
      && value.schemaVersion === 1
      && typeof value.modelId === "string"
      && "payload" in value
  );
}

function assertEntryGraphPayload(payload) {
  assert.equal(Boolean(payload && typeof payload === "object"), true);
  assert.equal("entries" in payload, true);
  assert.equal("leafId" in payload, true);
  assert.equal(Array.isArray(payload.entries), true);
  assert.equal(payload.leafId === null || typeof payload.leafId === "string", true);

  const ids = new Set();
  for (const entry of payload.entries) {
    assert.equal(entry.type, "message");
    assert.equal(typeof entry.id, "string");
    assert.equal(entry.id.length > 0, true);
    assert.equal(entry.parentId === null || typeof entry.parentId === "string", true);
    assert.equal(typeof entry.timestamp, "string");
    assert.equal(Boolean(entry.message && typeof entry.message === "object"), true);
    assert.equal(typeof entry.message.role, "string");
    assert.equal(ids.has(entry.id), false);
    ids.add(entry.id);
  }
  if (payload.leafId !== null) assert.equal(ids.has(payload.leafId), true);
  return payload;
}

