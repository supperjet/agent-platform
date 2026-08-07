import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SkillLoader } from "../skills/skill-loader.js";
import {
  createActiveSkillTracker,
  createSkillToolDefinitions,
  resolveSkillToolNamesForTurn,
} from "../skills/skill-tools.js";
import type { TurnContext } from "../context/context-assembler.js";
import { ContextBudget } from "../context/context-budget.js";

test("skill tools reject inactive skill calls", async () => {
  const agentDir = await createTempAgentDir();
  try {
    await writeSkillFile(agentDir, "review", "Review carefully.");
    await writeFile(
      join(agentDir, "skills/review/references/checklist.md"),
      "Check regressions.\n",
    );
    const registry = createRegistry(agentDir);
    const activeSkills = createActiveSkillTracker();
    const readTool = createSkillToolDefinitions({ registry, activeSkills })
      .find((tool) => tool.name === "skill_read_support_file");

    await assert.rejects(
      () => readTool?.execute("tool:read", {
        skillName: "review",
        fileName: "checklist.md",
      }),
      /No skill is active/,
    );
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("skill tools read, render, and run active skill support files", async () => {
  const agentDir = await createTempAgentDir();
  try {
    await writeSkillFile(agentDir, "review", "Review carefully.");
    await writeFile(
      join(agentDir, "skills/review/references/checklist.md"),
      "Check regressions.\n",
    );
    await writeFile(
      join(agentDir, "skills/review/templates/finding.md"),
      [
        "---",
        "variables:",
        "  target: File to review.",
        "---",
        "Finding for {{target}}.",
      ].join("\n"),
    );
    await writeFile(
      join(agentDir, "skills/review/scripts/echo.sh"),
      "echo tool:$SKILL_ARGS_JSON\n",
    );
    const registry = createRegistry(agentDir);
    const activeSkills = createActiveSkillTracker();
    activeSkills.setActiveSkills(["review"]);
    const tools = createSkillToolDefinitions({
      registry,
      activeSkills,
      workingDirectory: agentDir,
    });

    const readResult = await tools
      .find((tool) => tool.name === "skill_read_support_file")
      ?.execute("tool:read", {
        skillName: "review",
        fileName: "checklist.md",
      });
    const renderResult = await tools
      .find((tool) => tool.name === "skill_render_template")
      ?.execute("tool:render", {
        skillName: "review",
        templateName: "finding",
        variables: { target: "src/runtime.ts" },
      });
    const runResult = await tools
      .find((tool) => tool.name === "skill_run_script")
      ?.execute("tool:run", {
        skillName: "review",
        scriptName: "echo",
        args: ["alpha"],
      });

    assert.equal(readResult?.content[0]?.type, "text");
    assert.equal(readResult?.content[0]?.text, "Check regressions.\n");
    assert.equal(renderResult?.content[0]?.text, "Finding for src/runtime.ts.");
    assert.match(runResult?.content[0]?.text ?? "", /tool:\["alpha"\]/);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("skill turn resolver exposes support tools only for active skill manifests", () => {
  const inactiveToolNames = resolveSkillToolNamesForTurn({
    context: createTurnContext(),
    baseToolNames: ["inspect_runtime", "skill_read_support_file", "skill_run_script"],
  });
  const activeToolNames = resolveSkillToolNamesForTurn({
    context: createTurnContext({
      skillActivation: {
        name: "review",
        instructions: "Review carefully.",
        sourceInfo: { source: "sdk", label: "test", scope: "explicit" },
        supportFiles: [{
          kind: "reference",
          label: "checklist.md",
          sourceInfo: { source: "sdk", label: "checklist.md", scope: "explicit" },
          trustPolicy: {
            canRead: true,
            canInject: true,
            canExecute: false,
            reason: "reference can read",
          },
        }, {
          kind: "template",
          label: "finding.md",
          sourceInfo: { source: "sdk", label: "finding.md", scope: "explicit" },
          trustPolicy: {
            canRead: true,
            canInject: true,
            canExecute: false,
            reason: "template can read",
          },
        }, {
          kind: "script",
          label: "collect.sh",
          sourceInfo: { source: "sdk", label: "collect.sh", scope: "explicit" },
          trustPolicy: {
            canRead: false,
            canInject: false,
            canExecute: true,
            reason: "script can execute",
          },
        }],
      },
    }),
    baseToolNames: ["inspect_runtime", "skill_read_support_file"],
  });

  assert.deepEqual(inactiveToolNames, ["inspect_runtime"]);
  assert.deepEqual(activeToolNames, [
    "inspect_runtime",
    "skill_read_support_file",
    "skill_render_template",
    "skill_run_script",
  ]);
});

function createRegistry(agentDir: string) {
  return new SkillLoader({
    agentDir,
    now: () => new Date("2026-08-06T00:00:00.000Z"),
  }).createRegistry();
}

async function createTempAgentDir() {
  return mkdtemp(join(tmpdir(), "agent-core-skill-tools-"));
}

async function writeSkillFile(agentDir: string, name: string, content: string) {
  await mkdir(join(agentDir, `skills/${name}/references`), { recursive: true });
  await mkdir(join(agentDir, `skills/${name}/templates`), { recursive: true });
  await mkdir(join(agentDir, `skills/${name}/scripts`), { recursive: true });
  await writeFile(join(agentDir, `skills/${name}/SKILL.md`), content);
}

function createTurnContext(turn?: Record<string, unknown>): TurnContext {
  const budget = new ContextBudget().estimate([]);
  return {
    systemPrompt: "system",
    promptMessages: [],
    persistentPromptMessageIndexes: [],
    transientPromptMessageIndexes: [],
    conversationMessageCount: 0,
    messages: [],
    metadata: {
      ...(turn ? { turn } : {}),
      budget,
      diagnostics: {
        budget,
        injectedSources: [],
        persistentPromptMessageCount: 0,
        transientPromptMessageCount: 0,
      },
    },
  };
}
