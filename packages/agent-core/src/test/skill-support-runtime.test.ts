import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SkillLoader } from "../skills/skill-loader.js";
import { createSkillSupportRuntime } from "../skills/skill-support-runtime.js";

test("SkillSupportRuntime reads trusted support files", async () => {
  const agentDir = await createTempAgentDir();
  try {
    await writeSkillFile(agentDir, "review", "Review carefully.");
    await writeFile(
      join(agentDir, "skills/review/references/checklist.md"),
      "Check regressions.\n",
    );
    const runtime = createRuntime(agentDir);

    const result = await runtime.read({
      skillName: "review",
      fileName: "checklist.md",
    });

    assert.equal(result.status, "completed");
    assert.equal(result.file.file.kind, "reference");
    assert.equal(result.file.content, "Check regressions.\n");
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("SkillSupportRuntime rejects script reads by policy", async () => {
  const agentDir = await createTempAgentDir();
  try {
    await writeSkillFile(agentDir, "collect", "Collect data.");
    await writeFile(
      join(agentDir, "skills/collect/scripts/collect.js"),
      "console.log('collect');\n",
    );
    const runtime = createRuntime(agentDir);

    const result = await runtime.read({
      skillName: "collect",
      fileName: "collect.js",
    });

    assert.equal(result.status, "rejected");
    assert.equal(result.errorCode, "SUPPORT_FILE_REJECTED");
    assert.equal(result.policyRejected, true);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("SkillSupportRuntime renders skill templates", async () => {
  const agentDir = await createTempAgentDir();
  try {
    await writeSkillFile(agentDir, "review", "Review carefully.");
    await writeFile(
      join(agentDir, "skills/review/templates/finding.md"),
      [
        "---",
        "description: Finding template.",
        "variables:",
        "  target: File or directory to review.",
        "---",
        "",
        "Finding for {{target}}.",
      ].join("\n"),
    );
    const runtime = createRuntime(agentDir);

    const result = await runtime.renderTemplate({
      skillName: "review",
      templateName: "finding",
      variables: { target: "src/runtime.ts" },
    });

    assert.equal(result.status, "completed");
    assert.equal(result.template.name, "finding");
    assert.equal(result.template.description, "Finding template.");
    assert.equal(result.template.content, "Finding for src/runtime.ts.");
    assert.deepEqual(result.template.variableDefinitions, [{
      name: "target",
      description: "File or directory to review.",
    }]);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("SkillSupportRuntime reports template render failures", async () => {
  const agentDir = await createTempAgentDir();
  try {
    await writeSkillFile(agentDir, "review", "Review carefully.");
    await writeFile(
      join(agentDir, "skills/review/templates/finding.md"),
      [
        "---",
        "variables:",
        "  target: File or directory to review.",
        "---",
        "",
        "Finding for {{target}}.",
      ].join("\n"),
    );
    const runtime = createRuntime(agentDir);

    const result = await runtime.renderTemplate({
      skillName: "review",
      templateName: "finding",
    });

    assert.equal(result.status, "failed");
    assert.equal(result.errorCode, "TEMPLATE_RENDER_FAILED");
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

function createRuntime(agentDir: string) {
  const registry = new SkillLoader({
    agentDir,
    now: () => new Date("2026-08-06T00:00:00.000Z"),
  }).createRegistry();
  return createSkillSupportRuntime({ registry });
}

async function createTempAgentDir() {
  return mkdtemp(join(tmpdir(), "agent-core-skill-support-runtime-"));
}

async function writeSkillFile(agentDir: string, name: string, content: string) {
  await mkdir(join(agentDir, `skills/${name}/references`), { recursive: true });
  await mkdir(join(agentDir, `skills/${name}/templates`), { recursive: true });
  await mkdir(join(agentDir, `skills/${name}/scripts`), { recursive: true });
  await writeFile(join(agentDir, `skills/${name}/SKILL.md`), content);
}
