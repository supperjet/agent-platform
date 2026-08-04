import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createLifecycleRunner } from "../lifecycle/lifecycle-runner.js";
import { InputProcessor } from "../prompt/input-processor.js";
import {
  createPromptTemplateRegistry,
  definePromptTemplate,
} from "../prompt/prompt-template.js";
import {
  createSkillRegistry,
  defineSkill,
} from "../skills/skill-loader.js";

test("InputProcessor keeps the command when onInput continues", async () => {
  const command = { type: "prompt", text: "hello" } as const;
  const processor = new InputProcessor({
    lifecycleRunner: createLifecycleRunner({
      onInput: [() => ({ action: "continue" })],
    }),
  });

  assert.deepEqual(await processor.process({ command }), {
    status: "ready",
    command,
  });
});

test("InputProcessor returns the transformed command from onInput", async () => {
  const processor = new InputProcessor({
    lifecycleRunner: createLifecycleRunner({
      onInput: [
        ({ command }) => {
          assert.equal(command.type, "prompt");
          return {
            action: "transform",
            command: { type: "prompt", text: "expanded prompt" },
          };
        },
      ],
    }),
  });

  assert.deepEqual(
    await processor.process({
      command: { type: "prompt", text: "/expand" },
    }),
    {
      status: "ready",
      command: { type: "prompt", text: "expanded prompt" },
    },
  );
});

test("InputProcessor short-circuits handled input", async () => {
  const calls: string[] = [];
  const processor = new InputProcessor({
    lifecycleRunner: createLifecycleRunner({
      onInput: [
        () => {
          calls.push("first");
          return { action: "handled" };
        },
        () => {
          calls.push("second");
          return { action: "continue" };
        },
      ],
    }),
  });

  assert.deepEqual(
    await processor.process({
      command: { type: "prompt", text: "/local" },
    }),
    { status: "handled" },
  );
  assert.deepEqual(calls, ["first"]);
});

test("InputProcessor parses prompt slash command metadata without changing text", async () => {
  const processor = new InputProcessor();

  assert.deepEqual(
    await processor.process({
      command: { type: "prompt", text: "/review src/runtime.ts --strict" },
    }),
    {
      status: "ready",
      command: { type: "prompt", text: "/review src/runtime.ts --strict" },
      metadata: {
        slashCommand: "review",
        args: {
          raw: "src/runtime.ts --strict",
        },
      },
    },
  );
});

test("InputProcessor merges onInput metadata with parsed slash metadata", async () => {
  const processor = new InputProcessor({
    lifecycleRunner: createLifecycleRunner({
      onInput: [() => ({
        action: "continue",
        metadata: {
          inputMode: "command",
          selectedTemplate: "review-template",
        },
      })],
    }),
  });

  assert.deepEqual(
    await processor.process({
      command: { type: "prompt", text: "/review src/runtime.ts" },
    }),
    {
      status: "ready",
      command: { type: "prompt", text: "/review src/runtime.ts" },
      metadata: {
        slashCommand: "review",
        inputMode: "command",
        selectedTemplate: "review-template",
        args: {
          raw: "src/runtime.ts",
        },
      },
    },
  );
});

test("InputProcessor renders prompt template metadata from slash input", async () => {
  const registry = createPromptTemplateRegistry([
    definePromptTemplate({
      name: "review",
      label: "Review",
      content: "Review {{target}} with focus {{focus}}.",
      sourceInfo: { source: "sdk", label: "test", scope: "explicit" },
      priority: 100,
    }),
  ]);
  const processor = new InputProcessor({
    promptTemplateRegistry: registry,
  });

  assert.deepEqual(
    await processor.process({
      command: { type: "prompt", text: "/template review target=src/runtime.ts focus=\"missing tests\"" },
    }),
    {
      status: "ready",
      command: { type: "prompt", text: "/template review target=src/runtime.ts focus=\"missing tests\"" },
      metadata: {
        slashCommand: "template",
        inputMode: "template",
        selectedTemplate: "review",
        promptTemplate: {
          name: "review",
          content: "Review src/runtime.ts with focus missing tests.",
          variables: {
            target: "src/runtime.ts",
            focus: "missing tests",
          },
          sourceInfo: { source: "sdk", label: "test", scope: "explicit" },
        },
        args: {
          raw: "review target=src/runtime.ts focus=\"missing tests\"",
          templateName: "review",
          variables: {
            target: "src/runtime.ts",
            focus: "missing tests",
          },
        },
      },
    },
  );
});

test("InputProcessor activates skill metadata from slash input", async () => {
  const registry = createSkillRegistry([
    defineSkill({
      name: "review",
      label: "Review",
      description: "Review code changes.",
      instructions: "Report findings first.",
      sourceInfo: { source: "sdk", label: "test", scope: "explicit" },
      supportFiles: [],
      priority: 100,
      loadedAt: "2026-08-03T00:00:00.000Z",
    }),
  ]);
  const processor = new InputProcessor({
    skillRegistry: registry,
  });

  assert.deepEqual(
    await processor.process({
      command: { type: "prompt", text: "/skill use review src/runtime.ts" },
    }),
    {
      status: "ready",
      command: { type: "prompt", text: "/skill use review src/runtime.ts" },
      metadata: {
        slashCommand: "skill",
        inputMode: "skill",
        selectedSkill: "review",
        skillActivation: {
          name: "review",
          instructions: "Report findings first.",
          arguments: "src/runtime.ts",
          sourceInfo: { source: "sdk", label: "test", scope: "explicit" },
        },
        args: {
          raw: "use review src/runtime.ts",
          skillName: "review",
          skillArguments: "src/runtime.ts",
        },
      },
    },
  );
});

test("InputProcessor rejects model-disabled skills before prompt activation", async () => {
  const registry = createSkillRegistry([
    defineSkill({
      name: "export-snapshot",
      label: "Export Snapshot",
      description: "Export runtime state without model generation.",
      instructions: "Export a snapshot.",
      disableModelInvocation: true,
      sourceInfo: { source: "sdk", label: "test", scope: "explicit" },
      supportFiles: [],
      priority: 100,
      loadedAt: "2026-08-03T00:00:00.000Z",
    }),
  ]);
  const processor = new InputProcessor({
    skillRegistry: registry,
  });

  assert.deepEqual(
    await processor.process({
      command: { type: "prompt", text: "/skill use export-snapshot" },
    }),
    {
      status: "rejected",
      outcome: {
        status: "failed",
        errorCode: "INPUT_REJECTED",
        message: [
          'Skill "export-snapshot" declares disable_model_invocation: true.',
          "It cannot be executed through prompt injection until SkillRuntime is available.",
        ].join(" "),
      },
    },
  );
});

test("InputProcessor activates skill metadata with references by default", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-core-skill-activation-"));
  try {
    const referencePath = join(root, "skills/review/references/checklist.md");
    const templatePath = join(root, "skills/review/templates/finding.md");
    writeFile(referencePath, "Check regressions.");
    writeFile(templatePath, "Finding for {{target}}.");
    const registry = createSkillRegistry([
      defineSkill({
        name: "review",
        label: "Review",
        instructions: "Report findings first.",
        sourceInfo: { source: "sdk", label: "test", scope: "explicit" },
        supportFiles: [{
          kind: "reference",
          label: "checklist.md",
          path: referencePath,
          sourceInfo: { source: "file", label: "skills/review/references/checklist.md", path: referencePath, scope: "project" },
        }, {
          kind: "template",
          label: "finding.md",
          path: templatePath,
          sourceInfo: { source: "file", label: "skills/review/templates/finding.md", path: templatePath, scope: "project" },
        }],
        priority: 100,
        loadedAt: "2026-08-03T00:00:00.000Z",
      }),
    ]);
    const processor = new InputProcessor({
      skillRegistry: registry,
    });

    const result = await processor.process({
      command: { type: "prompt", text: "/skill use review src/runtime.ts target=src/runtime.ts" },
    });

    assert.equal(result.status, "ready");
    assert.deepEqual(result.metadata?.args, {
      raw: "use review src/runtime.ts target=src/runtime.ts",
      skillName: "review",
      skillArguments: "src/runtime.ts",
      variables: {
        target: "src/runtime.ts",
      },
    });
    assert.deepEqual(result.metadata?.skillActivation?.references?.map((reference) => ({
      kind: reference.file.kind,
      label: reference.file.sourceInfo.label,
      content: reference.content,
    })), [{
      kind: "reference",
      label: "skills/review/references/checklist.md",
      content: "Check regressions.",
    }]);
    assert.deepEqual(result.metadata?.skillActivation?.templates?.map((template) => ({
      name: template.name,
      content: template.content,
      variables: template.variables,
      sourceLabel: template.sourceInfo.label,
    })), [{
      name: "finding",
      content: "Finding for src/runtime.ts.",
      variables: {
        target: "src/runtime.ts",
      },
      sourceLabel: "skills/review/templates/finding.md",
    }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeFile(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
