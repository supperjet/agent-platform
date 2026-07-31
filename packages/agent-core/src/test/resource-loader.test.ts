import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { registerFauxProvider } from "@earendil-works/pi-ai";
import { formatAgentDefinition } from "../definition/agent-definition.js";
import { DefinitionResolver } from "../definition/definition-resolver.js";
import {
  ResourceCatalog,
  createAgentResourceRegistry,
  defineAgentResource
} from "../resources/resource-catalog.js";
import { ResourceLoader } from "../resources/resource-loader.js";
import { RuntimeAssembler } from "../runtime/runtime-assembler.js";
import { ToolsLoader } from "../tools/tool-loader.js";

test("ResourceLoader discovers text resources by agent directory convention", () => {
  const agentDir = createTempAgentDir();
  try {
    writeResource(agentDir, "resources/instructions/AGENTS.md", "Use two-space indentation.");
    writeResource(agentDir, "resources/memory/MEMORY.md", "User prefers concise answers.");
    writeResource(agentDir, "resources/references/architecture.md", "Core owns runtime assembly.");
    writeResource(agentDir, "resources/prompt-templates/review.md", "Review this change.");
    writeResource(agentDir, "skills/debugging/SKILL.md", "Debug with a narrow reproduction.");
    writeResource(agentDir, "tools/query.ts", "export const query = () => undefined;");

    const loader = new ResourceLoader({
      agentDir,
      now: () => new Date("2026-07-31T00:00:00.000Z")
    });

    const snapshot = loader.load();

    assert.deepEqual(snapshot.diagnostics, []);
    assert.deepEqual(snapshot.resources.map((resource) => ({
      kind: resource.kind,
      name: resource.name,
      label: resource.label,
      content: resource.content,
      loadedAt: resource.loadedAt
    })), [
      {
        kind: "instruction",
        name: "instruction:resources/instructions/AGENTS",
        label: "AGENTS",
        content: "Use two-space indentation.",
        loadedAt: "2026-07-31T00:00:00.000Z"
      },
      {
        kind: "memory",
        name: "memory:resources/memory/MEMORY",
        label: "MEMORY",
        content: "User prefers concise answers.",
        loadedAt: "2026-07-31T00:00:00.000Z"
      },
      {
        kind: "reference",
        name: "reference:resources/references/architecture",
        label: "architecture",
        content: "Core owns runtime assembly.",
        loadedAt: "2026-07-31T00:00:00.000Z"
      },
      {
        kind: "prompt-template",
        name: "prompt-template:resources/prompt-templates/review",
        label: "review",
        content: "Review this change.",
        loadedAt: "2026-07-31T00:00:00.000Z"
      },
      {
        kind: "skill",
        name: "skill:skills/debugging/SKILL",
        label: "SKILL",
        content: "Debug with a narrow reproduction.",
        loadedAt: "2026-07-31T00:00:00.000Z"
      }
    ]);
    assert.equal(snapshot.resources.some((resource) => resource.sourceInfo.path?.includes("tools/query.ts")), false);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("ResourceLoader creates a registry from directly injectable text resources", () => {
  const agentDir = createTempAgentDir();
  try {
    writeResource(agentDir, "resources/instructions/AGENTS.md", "Follow project rules.");
    writeResource(agentDir, "resources/memory/MEMORY.md", "Remember project decisions.");
    writeResource(agentDir, "resources/prompt-templates/plan.md", "Make a plan.");
    writeResource(agentDir, "skills/review/SKILL.md", "Review carefully.");

    const registry = new ResourceLoader({
      agentDir,
      now: () => new Date("2026-07-31T00:00:00.000Z")
    }).createRegistry();

    assert.deepEqual(registry.getAllDefinitions().map((resource) => resource.name), [
      "instruction:resources/instructions/AGENTS",
      "memory:resources/memory/MEMORY"
    ]);
    assert.equal(
      registry.getDefinition("memory:resources/memory/MEMORY")?.promptFragment,
      [
        `<memory_context source="${join(agentDir, "resources/memory/MEMORY.md")}">`,
        "Remember project decisions.",
        "</memory_context>"
      ].join("\n")
    );
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("ToolsLoader creates a registry from the agent tools entry", async () => {
  const agentDir = createTempAgentDir();
  try {
    writeResource(agentDir, "tools/index.js", [
      "export const tools = [{",
      "  name: \"inspect_runtime\",",
      "  label: \"Inspect Runtime\",",
      "  description: \"Inspect runtime state.\",",
      "  promptSnippet: \"Inspect runtime state.\",",
      "  promptGuidelines: [],",
      "  sourceInfo: { source: \"sdk\", label: \"test\" },",
      "  parameters: {},",
      "  async execute() {",
      "    return { content: [{ type: \"text\", text: \"ok\" }], details: {} };",
      "  }",
      "}];"
    ].join("\n"));

    const registry = await new ToolsLoader({ agentDir }).createRegistry();

    assert.deepEqual(registry.getAllEntries().map((entry) => entry.tool.name), [
      "inspect_runtime"
    ]);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("ResourceCatalog injects loaded context resources without treating skills or templates as prompt fragments", () => {
  const registration = registerFauxProvider({ provider: "resource-loader-test" });
  const agentDir = createTempAgentDir();
  try {
    writeResource(agentDir, "resources/instructions/AGENTS.md", "Follow project rules.");
    writeResource(agentDir, "resources/memory/MEMORY.md", "Project chose ResourceLoader first.");
    writeResource(agentDir, "resources/prompt-templates/plan.md", "Make a plan.");
    writeResource(agentDir, "skills/review/SKILL.md", "Review carefully.");
    const registryResource = defineAgentResource({
      name: "runtime_notes",
      label: "Runtime Notes",
      promptFragment: "Runtime notes from registry.",
      sourceInfo: { source: "sdk", label: "test" }
    });
    const catalog = new ResourceCatalog(
      createAgentResourceRegistry([registryResource]),
      new ResourceLoader({
        agentDir,
        now: () => new Date("2026-07-31T00:00:00.000Z")
      })
    );

    const definition = new DefinitionResolver().resolve(formatAgentDefinition({
      id: "resource-loader-agent",
      model: registration.getModel(),
      instructions: ["Use loaded resources."],
      toolNames: [],
      resourceNames: ["runtime_notes"]
    }));

    const snapshot = catalog.load({
      sessionId: "resource-loader-session",
      definition
    });

    assert.deepEqual(snapshot.promptFragments, [
      "Runtime notes from registry.",
      [
        `<project_instructions source="${join(agentDir, "resources/instructions/AGENTS.md")}">`,
        "Follow project rules.",
        "</project_instructions>"
      ].join("\n"),
      [
        `<memory_context source="${join(agentDir, "resources/memory/MEMORY.md")}">`,
        "Project chose ResourceLoader first.",
        "</memory_context>"
      ].join("\n")
    ]);
    assert.deepEqual(snapshot.resourceInfos.map((resource) => ({
      name: resource.name,
      kind: resource.kind
    })), [
      { name: "runtime_notes", kind: undefined },
      { name: "instruction:resources/instructions/AGENTS", kind: "instruction" },
      { name: "memory:resources/memory/MEMORY", kind: "memory" }
    ]);
    assert.deepEqual(snapshot.skillNames, ["skill:skills/review/SKILL"]);
    assert.equal(snapshot.loadedResources.length, 4);
    assert.deepEqual(snapshot.diagnostics, []);
  } finally {
    registration.unregister();
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("RuntimeAssembler accepts a resource loader as the text resource discovery path", () => {
  const registration = registerFauxProvider({ provider: "resource-loader-assembler-test" });
  const agentDir = createTempAgentDir();
  try {
    writeResource(agentDir, "resources/instructions/AGENTS.md", "Use the project convention.");
    writeResource(agentDir, "resources/memory/MEMORY.md", "The project chose file-backed memory v1.");
    writeResource(agentDir, "tools/ignored.ts", "export const ignored = true;");
    const assembler = new RuntimeAssembler({
      resourceLoader: new ResourceLoader({
        agentDir,
        now: () => new Date("2026-07-31T00:00:00.000Z")
      })
    });

    const assembly = assembler.assemble({
      sessionId: "resource-loader-assembly-session",
      definition: formatAgentDefinition({
        id: "resource-loader-assembly-agent",
        model: registration.getModel(),
        instructions: ["Assemble text resources."],
        toolNames: []
      }),
      resolveApiKey: () => "resource-loader-key"
    });

    assert.equal(
      assembly.systemPrompt,
      [
        "Assemble text resources.",
        [
          `<project_instructions source="${join(agentDir, "resources/instructions/AGENTS.md")}">`,
          "Use the project convention.",
          "</project_instructions>",
          "",
          `<memory_context source="${join(agentDir, "resources/memory/MEMORY.md")}">`,
          "The project chose file-backed memory v1.",
          "</memory_context>"
        ].join("\n")
      ].join("\n\n")
    );
    assert.equal(assembly.resources.loadedResources.length, 2);
  } finally {
    registration.unregister();
    rmSync(agentDir, { recursive: true, force: true });
  }
});

function createTempAgentDir(): string {
  return mkdtempSync(join(tmpdir(), "agent-core-resource-loader-"));
}

function writeResource(agentDir: string, relativePath: string, content: string) {
  const filePath = join(agentDir, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf-8");
}
