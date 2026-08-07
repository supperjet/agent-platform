import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createLocalProcessSandbox,
  createVirtualSandbox,
  type Sandbox,
} from "../sandbox/index.js";

test("VirtualSandbox supports in-memory file operations and just-bash exec", async () => {
  const sandbox = createVirtualSandbox();

  await sandbox.writeFile("notes/todo.txt", "first\n");
  assert.equal(await sandbox.readFile("notes/todo.txt"), "first\n");

  const result = await sandbox.exec({
    executable: "cat",
    args: ["notes/todo.txt"],
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "first\n");
  assert.equal(result.stderr, "");
});

test("LocalProcessSandbox supports file operations and process exec inside roots", async () => {
  const cwd = await makeTempDir();
  const sandbox = createLocalProcessSandbox({ cwd });

  await sandbox.writeFile("notes/todo.txt", "local\n");
  assert.equal(await readFile(join(cwd, "notes/todo.txt"), "utf-8"), "local\n");

  const result = await sandbox.exec({
    executable: process.execPath,
    args: ["-e", "console.log(process.cwd())"],
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), await realpath(cwd));
});

test("Sandbox adapters reject paths outside configured roots", async () => {
  await assertRejectsOutsideRoot(createVirtualSandbox());

  const cwd = await makeTempDir();
  await assertRejectsOutsideRoot(createLocalProcessSandbox({ cwd }));
});

test("Sandbox exec supports output limits", async () => {
  const virtual = createVirtualSandbox();
  const virtualResult = await virtual.exec({
    executable: "printf",
    args: ["abcdef"],
    outputLimitBytes: 3,
  });
  assert.equal(virtualResult.truncated, true);
  assert.equal(virtualResult.stdout, "abc");

  const cwd = await makeTempDir();
  const local = createLocalProcessSandbox({ cwd });
  const localResult = await local.exec({
    executable: process.execPath,
    args: ["-e", "process.stdout.write('abcdef')"],
    outputLimitBytes: 3,
  });
  assert.equal(localResult.truncated, true);
  assert.equal(localResult.stdout, "abc");
});

test("LocalProcessSandbox does not inherit arbitrary secrets by default", async () => {
  const cwd = await makeTempDir();
  const sandbox = createLocalProcessSandbox({ cwd });
  const result = await sandbox.exec({
    executable: process.execPath,
    args: ["-e", "console.log(process.env.SANDBOX_SECRET_SHOULD_NOT_EXIST ?? '')"],
    env: {},
  });
  assert.equal(result.stdout.trim(), "");
});

test("LocalProcessSandbox can opt in explicit environment values", async () => {
  const cwd = await makeTempDir();
  const sandbox = createLocalProcessSandbox({
    cwd,
    env: { SANDBOX_VISIBLE_VALUE: "allowed" },
  });
  const result = await sandbox.exec({
    executable: process.execPath,
    args: ["-e", "console.log(process.env.SANDBOX_VISIBLE_VALUE)"],
  });
  assert.equal(result.stdout.trim(), "allowed");
});

test("Sandbox exec reports timeouts as structured results", async () => {
  const virtual = createVirtualSandbox();
  const virtualResult = await virtual.exec({
    executable: "while true; do sleep 1; done",
    shell: true,
    timeoutMs: 10,
  });
  assert.equal(virtualResult.exitCode, 124);
  assert.equal(virtualResult.timedOut, true);

  const cwd = await makeTempDir();
  const local = createLocalProcessSandbox({ cwd });
  const localResult = await local.exec({
    executable: process.execPath,
    args: ["-e", "setTimeout(() => {}, 1000)"],
    timeoutMs: 10,
  });
  assert.equal(localResult.exitCode, 124);
  assert.equal(localResult.timedOut, true);
});

async function assertRejectsOutsideRoot(sandbox: Sandbox) {
  assert.throws(
    () => sandbox.resolvePath("../outside.txt"),
    /outside sandbox roots/,
  );
  await assert.rejects(
    () => sandbox.readFile("../outside.txt"),
    /outside sandbox roots/,
  );
}

async function makeTempDir() {
  return mkdtemp(join(tmpdir(), "agent-core-sandbox-"));
}
