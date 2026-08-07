import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentRuntimeEvent } from "../contracts.js";
import { SkillLoader } from "../skills/skill-loader.js";
import { createSkillSupportRuntime } from "../skills/skill-support-runtime.js";

test("SkillSupportRuntime runs scripts without frontmatter using extension defaults", async () => {
  const agentDir = await createTempAgentDir();
  try {
    await writeSkillFile(agentDir, "collect", "Collect data.");
    await writeFile(
      join(agentDir, "skills/collect/scripts/collect.sh"),
      "echo default:$SKILL_ARGS_JSON\n",
    );
    const { runtime, events } = createRuntime(agentDir);

    const result = await runtime.runScript({
      skillName: "collect",
      scriptName: "collect",
      args: ["alpha"],
    });

    assert.equal(result.status, "completed");
    assert.equal(result.sandboxKind, "virtual");
    assert.equal(result.exec.stdout, "default:[\"alpha\"]\n");
    assert.deepEqual(events.map((event) => event.type), [
      "skill_script_policy_checked",
      "skill_script_started",
      "skill_script_completed",
    ]);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("SkillSupportRuntime rejects scripts that declare execute false", async () => {
  const agentDir = await createTempAgentDir();
  try {
    await writeSkillFile(agentDir, "collect", "Collect data.");
    await writeFile(
      join(agentDir, "skills/collect/scripts/collect.sh"),
      [
        "---",
        "execute: false",
        "---",
        "echo should-not-run",
      ].join("\n"),
    );
    const { runtime, events } = createRuntime(agentDir);

    const result = await runtime.runScript({
      skillName: "collect",
      scriptName: "collect",
    });

    assert.equal(result.status, "rejected");
    assert.equal(result.errorCode, "SCRIPT_REJECTED");
    assert.deepEqual(events.map((event) => event.type), [
      "skill_script_policy_checked",
      "skill_script_failed",
    ]);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("SkillSupportRuntime runs executable scripts in VirtualSandbox", async () => {
  const agentDir = await createTempAgentDir();
  try {
    await writeSkillFile(agentDir, "collect", "Collect data.");
    await writeFile(
      join(agentDir, "skills/collect/scripts/collect.sh"),
      [
        "---",
        "execute: true",
        "sandbox: virtual",
        "timeout_ms: 1000",
        "---",
        "echo virtual:$SKILL_ARGS_JSON",
      ].join("\n"),
    );
    const { runtime, events } = createRuntime(agentDir);

    const result = await runtime.runScript({
      skillName: "collect",
      scriptName: "collect",
      args: ["alpha", "beta"],
    });

    assert.equal(result.status, "completed");
    assert.equal(result.sandboxKind, "virtual");
    assert.equal(result.exec.exitCode, 0);
    assert.equal(result.exec.stdout, "virtual:[\"alpha\",\"beta\"]\n");
    assert.deepEqual(events.map((event) => event.type), [
      "skill_script_policy_checked",
      "skill_script_started",
      "skill_script_completed",
    ]);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("SkillSupportRuntime requires explicit local sandbox declaration", async () => {
  const agentDir = await createTempAgentDir();
  try {
    await writeSkillFile(agentDir, "collect", "Collect data.");
    await writeFile(
      join(agentDir, "skills/collect/scripts/collect.sh"),
      [
        "---",
        "execute: true",
        "sandbox: virtual",
        "---",
        "echo local",
      ].join("\n"),
    );
    const { runtime } = createRuntime(agentDir);

    const result = await runtime.runScript({
      skillName: "collect",
      scriptName: "collect",
      sandboxKind: "local",
    });

    assert.equal(result.status, "rejected");
    assert.equal(result.message, "Local sandbox execution requires script metadata sandbox: local.");
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("SkillSupportRuntime runs explicitly local scripts without leaking arbitrary env", async () => {
  const agentDir = await createTempAgentDir();
  try {
    await writeSkillFile(agentDir, "collect", "Collect data.");
    await writeFile(
      join(agentDir, "skills/collect/scripts/collect.sh"),
      [
        "---",
        "execute: true",
        "sandbox: local",
        "---",
        "node -e \"console.log(process.env.SKILL_RUNTIME_SECRET ?? '')\"",
      ].join("\n"),
    );
    const { runtime } = createRuntime(agentDir);

    process.env.SKILL_RUNTIME_SECRET = "hidden";
    const result = await runtime.runScript({
      skillName: "collect",
      scriptName: "collect",
      sandboxKind: "local",
    });
    delete process.env.SKILL_RUNTIME_SECRET;

    assert.equal(result.status, "completed");
    assert.equal(result.exec.stdout.trim(), "");
  } finally {
    delete process.env.SKILL_RUNTIME_SECRET;
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("SkillSupportRuntime runs node scripts with comment frontmatter", async () => {
  const agentDir = await createTempAgentDir();
  try {
    await writeSkillFile(agentDir, "collect", "Collect data.");
    await writeFile(
      join(agentDir, "skills/collect/scripts/collect.js"),
      [
        "/*---",
        "execute: true",
        "sandbox: local",
        "interpreter: node",
        "---*/",
        "const args = JSON.parse(process.env.SKILL_ARGS_JSON ?? '[]');",
        "console.log(JSON.stringify({ args }));",
      ].join("\n"),
    );
    const { runtime } = createRuntime(agentDir);

    const result = await runtime.runScript({
      skillName: "collect",
      scriptName: "collect",
      args: ["alpha"],
    });

    assert.equal(result.status, "completed");
    assert.equal(result.exec.stdout.trim(), "{\"args\":[\"alpha\"]}");
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("SkillSupportRuntime runs node scripts without frontmatter using local sandbox defaults", async () => {
  const agentDir = await createTempAgentDir();
  try {
    await writeSkillFile(agentDir, "collect", "Collect data.");
    await writeFile(
      join(agentDir, "skills/collect/scripts/collect.js"),
      [
        "const args = JSON.parse(process.env.SKILL_ARGS_JSON ?? '[]');",
        "console.log(JSON.stringify({ cwd: process.cwd(), args }));",
      ].join("\n"),
    );
    const { runtime } = createRuntime(agentDir);

    const result = await runtime.runScript({
      skillName: "collect",
      scriptName: "collect",
      args: ["alpha"],
    });

    assert.equal(result.status, "completed");
    assert.equal(result.sandboxKind, "local");
    assert.equal(result.exec.stdout.trim(), `{"cwd":"${await realpath(agentDir)}","args":["alpha"]}`);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("SkillSupportRuntime rejects node scripts in VirtualSandbox", async () => {
  const agentDir = await createTempAgentDir();
  try {
    await writeSkillFile(agentDir, "collect", "Collect data.");
    await writeFile(
      join(agentDir, "skills/collect/scripts/collect.js"),
      [
        "/*---",
        "execute: true",
        "sandbox: virtual",
        "interpreter: node",
        "---*/",
        "console.log('nope');",
      ].join("\n"),
    );
    const { runtime } = createRuntime(agentDir);

    const result = await runtime.runScript({
      skillName: "collect",
      scriptName: "collect",
    });

    assert.equal(result.status, "rejected");
    assert.equal(result.message, "Node script execution requires sandbox: local.");
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("SkillSupportRuntime validates named script arguments and exposes structured env", async () => {
  const agentDir = await createTempAgentDir();
  try {
    await writeSkillFile(agentDir, "math", "Run math.");
    await writeFile(
      join(agentDir, "skills/math/scripts/sum.js"),
      [
        "/*---",
        "execute: true",
        "sandbox: local",
        "interpreter: node",
        "arg_numbers: number[] required Numbers to sum",
        "---*/",
        "const input = JSON.parse(process.env.SKILL_INPUT_JSON ?? '{}');",
        "const numbers = input.namedArgs.numbers;",
        "console.log(JSON.stringify({ status: 'ok', result: { sum: numbers.reduce((a, b) => a + b, 0), numbers } }));",
      ].join("\n"),
    );
    const { runtime, events } = createRuntime(agentDir);

    const result = await runtime.runScript({
      skillName: "math",
      scriptName: "sum",
      namedArgs: { numbers: "1,2,3" },
    });

    assert.equal(result.status, "completed");
    assert.equal(result.outcome, "succeeded");
    assert.deepEqual(result.structuredOutput?.result, {
      sum: 6,
      numbers: [1, 2, 3],
    });
    assert.equal(
      events.find((event) => event.type === "skill_script_completed")?.outcome,
      "succeeded",
    );
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("SkillSupportRuntime rejects missing required named script arguments", async () => {
  const agentDir = await createTempAgentDir();
  try {
    await writeSkillFile(agentDir, "math", "Run math.");
    await writeFile(
      join(agentDir, "skills/math/scripts/sum.js"),
      [
        "/*---",
        "execute: true",
        "sandbox: local",
        "interpreter: node",
        "arg_numbers: number[] required Numbers to sum",
        "---*/",
        "console.log('should not run');",
      ].join("\n"),
    );
    const { runtime, events } = createRuntime(agentDir);

    const result = await runtime.runScript({
      skillName: "math",
      scriptName: "sum",
    });

    assert.equal(result.status, "failed");
    assert.equal(result.errorCode, "SCRIPT_INVALID_ARGUMENTS");
    assert.match(result.message, /Missing required script argument: numbers/);
    assert.deepEqual(events.map((event) => event.type), [
      "skill_script_policy_checked",
      "skill_script_failed",
    ]);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("SkillSupportRuntime classifies exit code 2 as invalid arguments", async () => {
  const agentDir = await createTempAgentDir();
  try {
    await writeSkillFile(agentDir, "math", "Run math.");
    await writeFile(
      join(agentDir, "skills/math/scripts/sum.js"),
      [
        "const args = JSON.parse(process.env.SKILL_ARGS_JSON ?? '[]');",
        "console.error(JSON.stringify({ status: 'error', message: 'not a number' }));",
        "process.exit(2);",
      ].join("\n"),
    );
    const { runtime } = createRuntime(agentDir);

    const result = await runtime.runScript({
      skillName: "math",
      scriptName: "sum",
      args: ["oops"],
    });

    assert.equal(result.status, "completed");
    assert.equal(result.outcome, "invalid_arguments");
    assert.equal(result.exec.exitCode, 2);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

function createRuntime(agentDir: string) {
  const events: AgentRuntimeEvent[] = [];
  const registry = new SkillLoader({
    agentDir,
    now: () => new Date("2026-08-05T00:00:00.000Z"),
  }).createRegistry();
  const runtime = createSkillSupportRuntime({
    registry,
    sessionId: "test-session",
    workingDirectory: agentDir,
    onEvent: (event) => events.push(event),
  });
  return { runtime, events };
}

async function createTempAgentDir() {
  return mkdtemp(join(tmpdir(), "agent-core-skill-support-runtime-script-"));
}

async function writeSkillFile(agentDir: string, name: string, content: string) {
  await mkdir(join(agentDir, `skills/${name}/scripts`), { recursive: true });
  await writeFile(join(agentDir, `skills/${name}/SKILL.md`), content);
}
