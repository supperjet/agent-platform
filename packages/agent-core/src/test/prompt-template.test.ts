import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  PromptTemplateLoader,
  createPromptTemplateRegistry,
  definePromptTemplate,
  renderPromptTemplate,
} from "../prompt/prompt-template.js";

test("PromptTemplateLoader discovers templates by agent prompt directory convention", () => {
  const agentDir = createTempAgentDir();
  try {
    writeFile(agentDir, "prompt/templates/review.md", [
      "---",
      "description: Review a code change.",
      "variables:",
      "  target: Code path or module to review",
      "  focus: Review focus",
      "---",
      "",
      "Review {{target}} with focus {{focus}}.",
    ].join("\n"));
    writeFile(agentDir, "prompt/templates/workflows/plan.txt", "Plan this task.");
    writeFile(agentDir, "resources/memory/MEMORY.md", "Resource memory is separate.");
    writeFile(agentDir, "skills/review/SKILL.md", "Skill is separate.");
    writeFile(agentDir, "tools/index.ts", "export const tools = [];");

    const loader = new PromptTemplateLoader({
      agentDir,
      now: () => new Date("2026-08-03T00:00:00.000Z"),
    });

    const snapshot = loader.load();

    assert.deepEqual(snapshot.diagnostics, []);
    assert.deepEqual(snapshot.templates.map((template) => ({
      name: template.name,
      label: template.label,
      description: template.description,
      variableDefinitions: template.variableDefinitions,
      content: template.content,
      sourceLabel: template.sourceInfo.label,
      loadedAt: template.loadedAt,
    })), [
      {
        name: "review",
        label: "review",
        description: "Review a code change.",
        variableDefinitions: [
          { name: "target", description: "Code path or module to review" },
          { name: "focus", description: "Review focus" },
        ],
        content: "Review {{target}} with focus {{focus}}.",
        sourceLabel: "prompt/templates/review.md",
        loadedAt: "2026-08-03T00:00:00.000Z",
      },
      {
        name: "workflows/plan",
        label: "plan",
        description: undefined,
        variableDefinitions: undefined,
        content: "Plan this task.",
        sourceLabel: "prompt/templates/workflows/plan.txt",
        loadedAt: "2026-08-03T00:00:00.000Z",
      },
    ]);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("PromptTemplateLoader creates a registry without touching ResourceCatalog resources", () => {
  const agentDir = createTempAgentDir();
  try {
    writeFile(agentDir, "prompt/templates/review.md", "Review this change.");
    writeFile(agentDir, "resources/instructions/AGENTS.md", "Use project rules.");

    const registry = new PromptTemplateLoader({
      agentDir,
      now: () => new Date("2026-08-03T00:00:00.000Z"),
    }).createRegistry();

    assert.deepEqual(registry.getAllDefinitions().map((template) => template.name), [
      "review",
    ]);
    assert.equal(registry.getDefinition("review")?.content, "Review this change.");
    assert.equal(registry.getDefinition("instruction:resources/instructions/AGENTS"), undefined);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("PromptTemplateLoader parses frontmatter with CRLF line endings", () => {
  const agentDir = createTempAgentDir();
  try {
    writeFile(agentDir, "prompt/templates/review.md", [
      "---",
      "description: Review a CRLF template.",
      "variables:",
      "  target: Review target",
      "---",
      "",
      "Review {{target}}.",
    ].join("\r\n"));

    const registry = new PromptTemplateLoader({
      agentDir,
      now: () => new Date("2026-08-03T00:00:00.000Z"),
    }).createRegistry();
    const template = registry.getDefinition("review");

    assert.equal(template?.description, "Review a CRLF template.");
    assert.deepEqual(template?.variableDefinitions, [
      { name: "target", description: "Review target" },
    ]);
    assert.equal(template?.content, "Review {{target}}.");
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("PromptTemplateRegistry validates duplicate names and missing lookups", () => {
  assert.throws(() => createPromptTemplateRegistry([
    definePromptTemplate({
      name: "review",
      label: "Review",
      content: "Review one.",
      sourceInfo: { source: "sdk", label: "test", scope: "explicit" },
      priority: 100,
    }),
    definePromptTemplate({
      name: "review",
      label: "Review",
      content: "Review two.",
      sourceInfo: { source: "sdk", label: "test", scope: "explicit" },
      priority: 100,
    }),
  ]), /duplicate template name: review/);

  const registry = createPromptTemplateRegistry([]);
  assert.throws(() => registry.resolve(["review"]), /does not contain template: review/);
});

test("renderPromptTemplate injects variables into template content", () => {
  const rendered = renderPromptTemplate({
    template: definePromptTemplate({
      name: "review",
      label: "Review",
      description: "Review a code change.",
      variableDefinitions: [
        { name: "target", description: "Code path or module to review" },
        { name: "focus", description: "Review focus" },
      ],
      content: "Review {{target}} with focus {{focus}}.",
      sourceInfo: { source: "sdk", label: "test", scope: "explicit" },
      priority: 100,
    }),
    variables: {
      target: "src/runtime.ts",
      focus: "regressions",
    },
  });

  assert.deepEqual(rendered, {
    name: "review",
    content: "Review src/runtime.ts with focus regressions.",
    variables: {
      target: "src/runtime.ts",
      focus: "regressions",
    },
    description: "Review a code change.",
    variableDefinitions: [
      { name: "target", description: "Code path or module to review" },
      { name: "focus", description: "Review focus" },
    ],
    sourceInfo: { source: "sdk", label: "test", scope: "explicit" },
  });
});

test("renderPromptTemplate rejects missing placeholder variables", () => {
  assert.throws(() => renderPromptTemplate({
    template: definePromptTemplate({
      name: "review",
      label: "Review",
      content: "Review {{target}} with focus {{focus}}.",
      sourceInfo: { source: "sdk", label: "test", scope: "explicit" },
      priority: 100,
    }),
    variables: {
      target: "src/runtime.ts",
    },
  }), /missing variables: focus/);
});

test("renderPromptTemplate rejects missing declared variables", () => {
  assert.throws(() => renderPromptTemplate({
    template: definePromptTemplate({
      name: "review",
      label: "Review",
      variableDefinitions: [
        { name: "target", description: "Code path or module to review" },
        { name: "focus", description: "Review focus" },
      ],
      content: "Review {{target}}.",
      sourceInfo: { source: "sdk", label: "test", scope: "explicit" },
      priority: 100,
    }),
    variables: {
      target: "src/runtime.ts",
    },
  }), /missing variables: focus/);
});

function createTempAgentDir() {
  return mkdtempSync(join(tmpdir(), "agent-core-prompt-template-"));
}

function writeFile(root: string, relativePath: string, content: string) {
  const filePath = join(root, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}
