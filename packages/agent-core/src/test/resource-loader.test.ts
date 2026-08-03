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
    writeResource(agentDir, "prompt/templates/review.md", "Review this change.");
    writeResource(agentDir, "prompt/system/base.md", "Base prompt belongs to prompt assembly.");
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
      }
    ]);
    assert.equal(snapshot.resources.some((resource) => resource.sourceInfo.path?.includes("tools/query.ts")), false);
    assert.equal(snapshot.resources.some((resource) => resource.sourceInfo.path?.includes("prompt/templates/review.md")), false);
    assert.equal(snapshot.resources.some((resource) => resource.sourceInfo.path?.includes("prompt/system/base.md")), false);
    assert.equal(snapshot.resources.some((resource) => resource.sourceInfo.path?.includes("skills/debugging/SKILL.md")), false);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("ResourceLoader creates a registry from context text resources", () => {
  const agentDir = createTempAgentDir();
  try {
    writeResource(agentDir, "resources/instructions/AGENTS.md", "Follow project rules.");
    writeResource(agentDir, "resources/memory/MEMORY.md", "Remember project decisions.");
    writeResource(agentDir, "prompt/templates/plan.md", "Make a plan.");
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

test("ToolsLoader creates a registry from built-in tools and the agent tools entry", async () => {
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
      "read",
      "ls",
      "grep",
      "find",
      "write",
      "edit",
      "bash",
      "inspect_runtime"
    ]);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("ToolsLoader can create an agent-only registry without built-in tools", async () => {
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

    const registry = await new ToolsLoader({
      agentDir,
      includeBuiltInTools: false
    }).createRegistry();

    assert.deepEqual(registry.getAllEntries().map((entry) => entry.tool.name), [
      "inspect_runtime"
    ]);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("ResourceCatalog injects loaded context resources while prompt and skill files stay outside resources", () => {
  const registration = registerFauxProvider({ provider: "resource-loader-test" });
  const agentDir = createTempAgentDir();
  try {
    writeResource(agentDir, "resources/instructions/AGENTS.md", "Follow project rules.");
    writeResource(agentDir, "resources/memory/MEMORY.md", "Project chose ResourceLoader first.");
    writeResource(agentDir, "prompt/templates/plan.md", "Make a plan.");
    writeResource(agentDir, "skills/review/SKILL.md", "Review carefully.");
    const registryResource = defineAgentResource({
      name: "runtime_notes",
      label: "Runtime Notes",
      promptFragment: "Runtime notes from registry.",
      sourceInfo: { source: "sdk", label: "test" }
    });
    const loadedRegistry = new ResourceLoader({
      agentDir,
      now: () => new Date("2026-07-31T00:00:00.000Z")
    }).createRegistry();
    const resources = [
      registryResource,
      ...loadedRegistry.getAllDefinitions()
    ];
    const catalog = new ResourceCatalog(createAgentResourceRegistry(resources));

    const definition = new DefinitionResolver().resolve(formatAgentDefinition({
      id: "resource-loader-agent",
      model: registration.getModel(),
      instructions: ["Use loaded resources."],
      toolNames: [],
      resourceNames: resources.map((resource) => resource.name)
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
    assert.deepEqual(snapshot.contextFilePaths, [
      join(agentDir, "resources/instructions/AGENTS.md"),
      join(agentDir, "resources/memory/MEMORY.md")
    ]);
    assert.equal(snapshot.loadedResources.length, 0);
    assert.deepEqual(snapshot.diagnostics, []);
  } finally {
    registration.unregister();
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("RuntimeAssembler accepts a resource registry created from the resource loader", () => {
  const registration = registerFauxProvider({ provider: "resource-loader-assembler-test" });
  const agentDir = createTempAgentDir();
  try {
    writeResource(agentDir, "resources/instructions/AGENTS.md", "Use the project convention.");
    writeResource(agentDir, "resources/memory/MEMORY.md", "The project chose file-backed memory v1.");
    writeResource(agentDir, "tools/ignored.ts", "export const ignored = true;");
    const resourceRegistry = new ResourceLoader({
      agentDir,
      now: () => new Date("2026-07-31T00:00:00.000Z")
    }).createRegistry();
    const assembler = new RuntimeAssembler({
      resourceRegistry
    });

    const assembly = assembler.assemble({
      sessionId: "resource-loader-assembly-session",
      definition: formatAgentDefinition({
        id: "resource-loader-assembly-agent",
        model: registration.getModel(),
        instructions: ["Assemble text resources."],
        toolNames: [],
        resourceNames: resourceRegistry.getAllDefinitions().map((resource) => resource.name)
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
    assert.deepEqual(assembly.resources.contextFilePaths, [
      join(agentDir, "resources/instructions/AGENTS.md"),
      join(agentDir, "resources/memory/MEMORY.md")
    ]);
    assert.equal(assembly.resources.loadedResources.length, 0);
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
