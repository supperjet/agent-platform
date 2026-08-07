import assert from "node:assert/strict";
import test from "node:test";
import {
  formatSkill,
  formatSkills,
} from "../cli/agent/main.js";
import {
  createSkillRegistry,
  defineSkill,
  type SkillDiagnostic,
} from "../skills/skill-loader.js";

test("formatSkills includes loader diagnostics", () => {
  const diagnostics: SkillDiagnostic[] = [{
    type: "warning",
    code: "duplicate-skill",
    message: "Duplicate skill skipped: review",
    path: "/agent/skills/review/SKILL.md",
  }];
  const registry = createSkillRegistry([
    defineSkill({
      name: "review",
      label: "Review",
      description: "Review code changes.",
      instructions: "Report findings first.",
      disableModelInvocation: true,
      sourceInfo: { source: "sdk", label: "test", scope: "explicit" },
      supportFiles: [],
      priority: 100,
      loadedAt: "2026-08-03T00:00:00.000Z",
    }),
  ]);

  assert.equal(formatSkills(registry, diagnostics), [
    "skills:",
    "- review",
    "  description: Review code changes.",
    "  disable_model_invocation: true",
    "  source: test",
    "",
    "skill diagnostics:",
    "- warning: duplicate-skill: Duplicate skill skipped: review",
    "  path: /agent/skills/review/SKILL.md",
    "",
  ].join("\n"));
});

test("formatSkill includes support trust policy diagnostics", () => {
  const registry = createSkillRegistry([
    defineSkill({
      name: "collect",
      label: "Collect",
      instructions: "Collect local data.",
      sourceInfo: { source: "sdk", label: "test", scope: "explicit" },
      supportFiles: [{
        kind: "script",
        label: "collect.ts",
        path: "/agent/skills/collect/scripts/collect.ts",
        sourceInfo: {
          source: "file",
          label: "skills/collect/scripts/collect.ts",
          path: "/agent/skills/collect/scripts/collect.ts",
          scope: "project",
        },
        trustPolicy: {
          canRead: false,
          canInject: false,
          canExecute: false,
          reason: "scripts require SkillSupportRuntime and ToolRuntime approval before they can be read or executed",
        },
      }],
      priority: 100,
      loadedAt: "2026-08-03T00:00:00.000Z",
    }),
  ]);

  assert.equal(formatSkill(registry, "collect"), [
    "skill: collect",
    "source: test",
    "support files:",
    "- script: skills/collect/scripts/collect.ts",
    "  runtime policy: read=no, inject=no, execute=no",
    "  policy reason: scripts require SkillSupportRuntime and ToolRuntime approval before they can be read or executed",
    "",
    "Collect local data.",
    "",
    "support file diagnostics:",
    "- warning: trust-policy-denied: Skill support file read denied by trust policy: scripts require SkillSupportRuntime and ToolRuntime approval before they can be read or executed",
    "  path: /agent/skills/collect/scripts/collect.ts",
    "",
  ].join("\n"));
});
