import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  SkillLoader,
  activateSkill,
  createSkillRegistry,
  defineSkill,
  readSkillReferenceFiles,
  readSkillSupportFiles,
  readSkillTemplateFiles,
} from "../skills/skill-loader.js";

test("SkillLoader discovers SKILL.md packages by agent skills directory convention", () => {
  const agentDir = createTempAgentDir();
  try {
    writeFile(agentDir, "skills/review/SKILL.md", [
      "---",
      "name: review",
      "description: Review code changes and report findings first.",
      "disable_model_invocation: true",
      "---",
      "",
      "## Instructions",
      "",
      "Report findings first, ordered by severity.",
    ].join("\n"));
    writeFile(agentDir, "skills/review/references/checklist.md", "Check regressions.");
    writeFile(agentDir, "skills/review/templates/finding.md", "Finding template.");
    writeFile(agentDir, "skills/review/scripts/collect-diff.ts", "export {};");
    writeFile(agentDir, "resources/instructions/AGENTS.md", "Resource is separate.");
    writeFile(agentDir, "prompt/templates/review.md", "Template is separate.");
    writeFile(agentDir, "tools/index.ts", "export const tools = [];");

    const loader = new SkillLoader({
      agentDir,
      now: () => new Date("2026-08-03T00:00:00.000Z"),
    });

    const snapshot = loader.load();

    assert.deepEqual(snapshot.diagnostics, []);
    assert.deepEqual(snapshot.skills.map((skill) => ({
      name: skill.name,
      label: skill.label,
      description: skill.description,
      disableModelInvocation: skill.disableModelInvocation,
      instructions: skill.instructions,
      sourceLabel: skill.sourceInfo.label,
      supportFiles: skill.supportFiles.map((file) => ({
        kind: file.kind,
        label: file.label,
        sourceLabel: file.sourceInfo.label,
      })),
      loadedAt: skill.loadedAt,
    })), [
      {
        name: "review",
        label: "review",
        description: "Review code changes and report findings first.",
        disableModelInvocation: true,
        instructions: [
          "## Instructions",
          "",
          "Report findings first, ordered by severity.",
        ].join("\n"),
        sourceLabel: "skills/review/SKILL.md",
        supportFiles: [
          {
            kind: "reference",
            label: "checklist.md",
            sourceLabel: "skills/review/references/checklist.md",
          },
          {
            kind: "script",
            label: "collect-diff.ts",
            sourceLabel: "skills/review/scripts/collect-diff.ts",
          },
          {
            kind: "template",
            label: "finding.md",
            sourceLabel: "skills/review/templates/finding.md",
          },
        ],
        loadedAt: "2026-08-03T00:00:00.000Z",
      },
    ]);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("SkillLoader infers the skill name from the directory when frontmatter omits it", () => {
  const agentDir = createTempAgentDir();
  try {
    writeFile(agentDir, "skills/workflows/plan/SKILL.md", [
      "---",
      "description: Plan a task.",
      "---",
      "",
      "Plan before editing.",
    ].join("\r\n"));

    const registry = new SkillLoader({
      agentDir,
      now: () => new Date("2026-08-03T00:00:00.000Z"),
    }).createRegistry();

    const skill = registry.getDefinition("workflows/plan");
    assert.equal(skill?.name, "workflows/plan");
    assert.equal(skill?.description, "Plan a task.");
    assert.equal(skill?.instructions, "Plan before editing.");
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("SkillLoader accepts hyphenated disable model invocation frontmatter", () => {
  const agentDir = createTempAgentDir();
  try {
    writeFile(agentDir, "skills/review/SKILL.md", [
      "---",
      "name: review",
      "disable-model-invocation: true",
      "---",
      "",
      "Review carefully.",
    ].join("\n"));

    const snapshot = new SkillLoader({
      agentDir,
      now: () => new Date("2026-08-03T00:00:00.000Z"),
    }).load();

    assert.equal(snapshot.diagnostics.length, 0);
    assert.equal(snapshot.skills[0]?.disableModelInvocation, true);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("SkillLoader records duplicate skill names as diagnostics and keeps the first one", () => {
  const agentDir = createTempAgentDir();
  try {
    writeFile(agentDir, "skills/a/SKILL.md", [
      "---",
      "name: review",
      "---",
      "",
      "First review skill.",
    ].join("\n"));
    writeFile(agentDir, "skills/b/SKILL.md", [
      "---",
      "name: review",
      "---",
      "",
      "Second review skill.",
    ].join("\n"));

    const snapshot = new SkillLoader({
      agentDir,
      now: () => new Date("2026-08-03T00:00:00.000Z"),
    }).load();

    assert.deepEqual(snapshot.skills.map((skill) => skill.instructions), [
      "First review skill.",
    ]);
    assert.deepEqual(snapshot.diagnostics.map((diagnostic) => diagnostic.code), [
      "duplicate-skill",
    ]);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("SkillLoader reports invalid frontmatter as diagnostics", () => {
  const agentDir = createTempAgentDir();
  try {
    writeFile(agentDir, "skills/review/SKILL.md", [
      "---",
      "name: bad name",
      "disable_model_invocation: maybe",
      "---",
      "",
      "Review carefully.",
    ].join("\n"));

    const snapshot = new SkillLoader({
      agentDir,
      now: () => new Date("2026-08-03T00:00:00.000Z"),
    }).load();

    assert.deepEqual(snapshot.skills, []);
    assert.deepEqual(snapshot.diagnostics.map((diagnostic) => diagnostic.code), [
      "invalid-frontmatter",
    ]);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("readSkillSupportFiles reads support content and reports missing files as diagnostics", () => {
  const agentDir = createTempAgentDir();
  try {
    writeFile(agentDir, "skills/review/SKILL.md", "Review carefully.");
    writeFile(agentDir, "skills/review/references/checklist.md", "Check regressions.");
    writeFile(agentDir, "skills/review/templates/finding.md", "Finding template.");
    writeFile(agentDir, "skills/review/scripts/collect-diff.ts", "export {};");
    const snapshot = new SkillLoader({
      agentDir,
      now: () => new Date("2026-08-03T00:00:00.000Z"),
    }).load();
    const skill = snapshot.skills[0];
    assert.ok(skill);

    rmSync(join(agentDir, "skills/review/templates/finding.md"));

    const supportFileSnapshot = readSkillSupportFiles(skill);

    assert.deepEqual(supportFileSnapshot.files.map((file) => ({
      kind: file.file.kind,
      content: file.content,
    })), [
      {
        kind: "reference",
        content: "Check regressions.",
      },
    ]);
    assert.deepEqual(supportFileSnapshot.diagnostics.map((diagnostic) => diagnostic.code), [
      "trust-policy-denied",
      "read-failed",
    ]);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("SkillLoader rejects symlinked support files by trust policy", () => {
  const agentDir = createTempAgentDir();
  try {
    writeFile(agentDir, "outside.md", "Outside content.");
    writeFile(agentDir, "skills/review/SKILL.md", "Review carefully.");
    mkdirSync(join(agentDir, "skills/review/references"), { recursive: true });
    symlinkSync(
      join(agentDir, "outside.md"),
      join(agentDir, "skills/review/references/outside.md"),
    );

    const snapshot = new SkillLoader({
      agentDir,
      now: () => new Date("2026-08-03T00:00:00.000Z"),
    }).load();

    assert.deepEqual(snapshot.skills[0]?.supportFiles, []);
    assert.deepEqual(snapshot.diagnostics.map((diagnostic) => diagnostic.code), [
      "trust-policy-denied",
    ]);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("readSkillReferenceFiles reads only reference support files", () => {
  const agentDir = createTempAgentDir();
  try {
    writeFile(agentDir, "skills/review/SKILL.md", "Review carefully.");
    writeFile(agentDir, "skills/review/references/checklist.md", "Check regressions.");
    writeFile(agentDir, "skills/review/templates/finding.md", "Finding template.");
    writeFile(agentDir, "skills/review/scripts/collect-diff.ts", "export {};");
    const snapshot = new SkillLoader({
      agentDir,
      now: () => new Date("2026-08-03T00:00:00.000Z"),
    }).load();
    const skill = snapshot.skills[0];
    assert.ok(skill);

    const referenceSnapshot = readSkillReferenceFiles(skill);

    assert.deepEqual(referenceSnapshot.diagnostics, []);
    assert.deepEqual(referenceSnapshot.files.map((file) => ({
      kind: file.file.kind,
      sourceLabel: file.file.sourceInfo.label,
      content: file.content,
    })), [{
      kind: "reference",
      sourceLabel: "skills/review/references/checklist.md",
      content: "Check regressions.",
    }]);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("readSkillTemplateFiles reads only template support files", () => {
  const agentDir = createTempAgentDir();
  try {
    writeFile(agentDir, "skills/review/SKILL.md", "Review carefully.");
    writeFile(agentDir, "skills/review/references/checklist.md", "Check regressions.");
    writeFile(agentDir, "skills/review/templates/finding.md", [
      "---",
      "description: Finding template.",
      "variables:",
      "  target: File or directory to review.",
      "---",
      "",
      "Finding for {{target}}.",
    ].join("\n"));
    writeFile(agentDir, "skills/review/scripts/collect-diff.ts", "export {};");
    const snapshot = new SkillLoader({
      agentDir,
      now: () => new Date("2026-08-03T00:00:00.000Z"),
    }).load();
    const skill = snapshot.skills[0];
    assert.ok(skill);

    const templateSnapshot = readSkillTemplateFiles(skill);

    assert.deepEqual(templateSnapshot.diagnostics, []);
    assert.deepEqual(templateSnapshot.files.map((file) => ({
      kind: file.file.kind,
      sourceLabel: file.file.sourceInfo.label,
      content: file.content,
    })), [{
      kind: "template",
      sourceLabel: "skills/review/templates/finding.md",
      content: [
        "---",
        "description: Finding template.",
        "variables:",
        "  target: File or directory to review.",
        "---",
        "",
        "Finding for {{target}}.",
      ].join("\n"),
    }]);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("activateSkill renders skill templates and reports missing variables", () => {
  const agentDir = createTempAgentDir();
  try {
    writeFile(agentDir, "skills/review/SKILL.md", "Review carefully.");
    writeFile(agentDir, "skills/review/templates/finding.md", [
      "---",
      "description: Finding template.",
      "variables:",
      "  target: File or directory to review.",
      "---",
      "",
      "Finding for {{target}}.",
    ].join("\n"));
    const snapshot = new SkillLoader({
      agentDir,
      now: () => new Date("2026-08-03T00:00:00.000Z"),
    }).load();
    const skill = snapshot.skills[0];
    assert.ok(skill);

    const rendered = activateSkill(skill, { variables: { target: "src/runtime.ts" } });
    const missing = activateSkill(skill);

    assert.deepEqual(rendered.templates?.map((template) => ({
      name: template.name,
      content: template.content,
      variables: template.variables,
      variableDefinitions: template.variableDefinitions,
    })), [{
      name: "finding",
      content: "Finding for src/runtime.ts.",
      variables: {
        target: "src/runtime.ts",
      },
      variableDefinitions: [{
        name: "target",
        description: "File or directory to review.",
      }],
    }]);
    assert.deepEqual(missing.templates, undefined);
    assert.deepEqual(missing.diagnostics?.map((diagnostic) => diagnostic.code), [
      "render-failed",
    ]);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("SkillRegistry validates duplicate names and missing lookups", () => {
  assert.throws(() => createSkillRegistry([
    defineSkill({
      name: "review",
      label: "Review",
      instructions: "Review one.",
      sourceInfo: { source: "sdk", label: "test", scope: "explicit" },
      supportFiles: [],
      priority: 100,
      loadedAt: "2026-08-03T00:00:00.000Z",
    }),
    defineSkill({
      name: "review",
      label: "Review",
      instructions: "Review two.",
      sourceInfo: { source: "sdk", label: "test", scope: "explicit" },
      supportFiles: [],
      priority: 100,
      loadedAt: "2026-08-03T00:00:00.000Z",
    }),
  ]), /duplicate skill name: review/);

  const registry = createSkillRegistry([]);
  assert.throws(() => registry.resolve(["review"]), /does not contain skill: review/);
});

function createTempAgentDir() {
  return mkdtempSync(join(tmpdir(), "agent-core-skill-loader-"));
}

function writeFile(root: string, relativePath: string, content: string) {
  const filePath = join(root, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}
