import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition
} from "../tools/built-in/index.js";
import { createLocalToolOperations } from "../tools/operations/local-tool-operations.js";
import { createAgentToolRegistry } from "../tools/tool-registry.js";

test("manually registered read-only built-in tools can inspect files without mutation tools", async () => {
  const cwd = await makeFixtureWorkspace();
  const operations = createLocalToolOperations({ cwd });
  const registry = createAgentToolRegistry([
    createReadToolDefinition(operations),
    createLsToolDefinition(operations),
    createGrepToolDefinition(operations)
  ]);

  assert.deepEqual(registry.getAllEntries().map((entry) => entry.tool.name), ["read", "ls", "grep"]);
  assert.equal(registry.getEntry("write"), undefined);

  const read = registry.getEntry("read")?.tool;
  const grep = registry.getEntry("grep")?.tool;
  assert.ok(read);
  assert.ok(grep);

  const readResult = await read.execute("tool:read", { path: "src/index.ts" });
  assert.match(readText(readResult), /export const answer = 42;/);

  const grepResult = await grep.execute("tool:grep", {
    pattern: "answer",
    path: "src",
    literal: true
  });
  assert.match(readText(grepResult), /src\/index\.ts:1: export const answer = 42;/);
});

test("manually registered write and edit tools can mutate inside the workspace root", async () => {
  const cwd = await makeFixtureWorkspace();
  const operations = createLocalToolOperations({ cwd });
  const registry = createAgentToolRegistry([
    createWriteToolDefinition(operations),
    createEditToolDefinition(operations)
  ]);
  const write = registry.getEntry("write")?.tool;
  const edit = registry.getEntry("edit")?.tool;
  assert.ok(write);
  assert.ok(edit);

  await write.execute("tool:write", {
    path: "notes/todo.txt",
    content: "first draft\n"
  });
  assert.equal(await readFile(join(cwd, "notes/todo.txt"), "utf-8"), "first draft\n");

  await edit.execute("tool:edit", {
    path: "notes/todo.txt",
    oldText: "first",
    newText: "final"
  });
  assert.equal(await readFile(join(cwd, "notes/todo.txt"), "utf-8"), "final draft\n");
});

test("bash is available only when callers manually register it", async () => {
  const cwd = await makeFixtureWorkspace();
  const operations = createLocalToolOperations({ cwd });
  const writeRegistry = createAgentToolRegistry([
    createReadToolDefinition(operations),
    createWriteToolDefinition(operations)
  ]);
  const commandRegistry = createAgentToolRegistry([
    createReadToolDefinition(operations),
    createBashToolDefinition(operations)
  ]);

  assert.equal(writeRegistry.getEntry("bash"), undefined);
  const bash = commandRegistry.getEntry("bash")?.tool;
  assert.ok(bash);

  const result = await bash.execute("tool:bash", { command: "pwd" });
  assert.match(readText(result), new RegExp(escapeRegExp(cwd)));
});

test("built-in tools honor aborted execution signals", async () => {
  const cwd = await makeFixtureWorkspace();
  const operations = createLocalToolOperations({ cwd });
  const registry = createAgentToolRegistry([
    createReadToolDefinition(operations),
    createBashToolDefinition(operations)
  ]);
  const read = registry.getEntry("read")?.tool;
  const bash = registry.getEntry("bash")?.tool;
  assert.ok(read);
  assert.ok(bash);

  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => read.execute("tool:read", { path: "src/index.ts" }, controller.signal),
    /aborted/i
  );
  await assert.rejects(
    () => bash.execute("tool:bash", { command: "pwd" }, controller.signal),
    /aborted/i
  );
});

test("local core tool operations reject paths outside the configured root", async () => {
  const cwd = await makeFixtureWorkspace();
  const operations = createLocalToolOperations({ cwd });
  const registry = createAgentToolRegistry([
    createReadToolDefinition(operations)
  ]);
  const read = registry.getEntry("read")?.tool;
  assert.ok(read);

  await assert.rejects(
    () => read.execute("tool:read", { path: "../outside.txt" }),
    /outside allowed roots/
  );
});

async function makeFixtureWorkspace() {
  const cwd = await mkdtemp(join(tmpdir(), "agent-core-tools-"));
  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(join(cwd, "src/index.ts"), "export const answer = 42;\n", "utf-8");
  return cwd;
}

function readText(result: unknown): string {
  if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content)) return "";
  return result.content.flatMap((block: unknown) => {
    if (!block || typeof block !== "object" || !("type" in block) || block.type !== "text") return [];
    return "text" in block && typeof block.text === "string" ? [block.text] : [];
  }).join("\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
