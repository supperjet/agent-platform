import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { registerFauxProvider, Type } from "@earendil-works/pi-ai";
import type { ConversationEntry } from "../conversation/conversation-entry.js";
import { exportConversationEntriesState, exportConversationState } from "../conversation/conversation-state.js";
import { formatAgentDefinition } from "../definition/agent-definition.js";
import {
  ResourceCatalog,
  createAgentResourceRegistry,
  defineAgentResource,
  type AgentResourceDefinition
} from "../resources/resource-catalog.js";
import { RuntimeAssembler } from "../runtime/runtime-assembler.js";
import {
  createAgentToolRegistry,
  defineAgentTool,
  type AgentToolDefinition,
  wrapAgentToolDefinition
} from "../tools/tool-registry.js";
import { ToolCatalog } from "../tools/tool-catalog.js";

test("assembles static instructions into a prompt plan", () => {
  const registration = registerFauxProvider({ provider: "runtime-assembler-static-test" });
  const assembler = new RuntimeAssembler();

  try {
    const assembly = assembler.assemble({
      sessionId: "session-assembly-static",
      definition: formatAgentDefinition({
        id: "assembly-static-agent",
        model: registration.getModel(),
        instructions: [
          " Answer in Chinese. ",
          "Use configured tools only."
        ],
        toolNames: []
      }),
      resolveApiKey: () => "core-only-key"
    });

    assert.equal(assembly.systemPrompt, "Answer in Chinese. Use configured tools only.");
    assert.equal(assembly.promptPlan.systemPrompt, assembly.systemPrompt);
    assert.equal(assembly.model.id, registration.getModel().id);
    assert.deepEqual(assembly.messages, []);
    assert.deepEqual(assembly.resources.promptFragments, []);
    assert.equal(assembly.lifecycle.name, "default");
    assert.equal(assembly.policies.queue, "direct");
  } finally {
    registration.unregister();
  }
});

test("restores conversation messages through the conversation store", () => {
  const registration = registerFauxProvider({ provider: "runtime-assembler-restore-test" });
  const messages: AgentMessage[] = [
    { role: "user", content: "first" } as AgentMessage
  ];
  const state = exportConversationState(registration.getModel().id, messages);
  const assembler = new RuntimeAssembler();

  try {
    const assembly = assembler.assemble({
      sessionId: "session-assembly-restore",
      definition: formatAgentDefinition({
        id: "assembly-restore-agent",
        model: registration.getModel(),
        instructions: ["Answer briefly."],
        toolNames: []
      }),
      state,
      resolveApiKey: () => "core-only-key"
    });

    assert.deepEqual(assembly.messages.map((message) => message.role), ["user"]);
    assert.notEqual(assembly.messages, messages);
  } finally {
    registration.unregister();
  }
});

test("restores v1 entry graph state through the conversation store", () => {
  const registration = registerFauxProvider({ provider: "runtime-assembler-graph-restore-test" });
  const entries: ConversationEntry[] = [
    {
      type: "message",
      id: "root",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: "root path" } as AgentMessage
    },
    {
      type: "message",
      id: "main",
      parentId: "root",
      timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "assistant", content: "main answer" } as unknown as AgentMessage
    },
    {
      type: "message",
      id: "branch",
      parentId: "root",
      timestamp: "2026-01-01T00:00:02.000Z",
      message: { role: "assistant", content: "branch answer" } as unknown as AgentMessage
    }
  ];
  const state = exportConversationEntriesState(registration.getModel().id, entries, "branch");
  const assembler = new RuntimeAssembler();

  try {
    const assembly = assembler.assemble({
      sessionId: "session-assembly-graph-restore",
      definition: formatAgentDefinition({
        id: "assembly-graph-restore-agent",
        model: registration.getModel(),
        instructions: ["Answer from the active branch."],
        toolNames: []
      }),
      state,
      resolveApiKey: () => "core-only-key"
    });

    assert.deepEqual(assembly.conversation.entries.map((entry) => entry.id), ["root", "main", "branch"]);
    assert.equal(assembly.conversation.leafId, "branch");
    assert.deepEqual(assembly.messages.map(readTextContent), ["root path", "branch answer"]);
    assert.deepEqual(assembly.conversation.compatibility, {
      modelId: registration.getModel().id,
      definitionId: "assembly-graph-restore-agent"
    });
    assert.notEqual(assembly.conversation.entries, entries);
  } finally {
    registration.unregister();
  }
});

test("rejects conversation state saved for a different model during assembly", () => {
  const registration = registerFauxProvider({ provider: "runtime-assembler-model-mismatch-test" });
  const state = exportConversationEntriesState("other-provider:other-model", [], null);
  const assembler = new RuntimeAssembler();

  try {
    assert.throws(
      () => assembler.assemble({
        sessionId: "session-assembly-model-mismatch",
        definition: formatAgentDefinition({
          id: "assembly-model-mismatch-agent",
          model: registration.getModel(),
          instructions: ["Answer briefly."],
          toolNames: []
        }),
        state,
        resolveApiKey: () => "core-only-key"
      }),
      new RegExp(`Agent conversation model "other-provider:other-model" does not match runtime model "${registration.getModel().id}"`)
    );
  } finally {
    registration.unregister();
  }
});

test("resolves tools through the tool catalog", () => {
  const registration = registerFauxProvider({ provider: "runtime-assembler-tool-test" });
  const inspectTool = createInspectTool();
  const assembler = new RuntimeAssembler({
    toolRegistry: createAgentToolRegistry([inspectTool])
  });

  try {
    const assembly = assembler.assemble({
      sessionId: "session-assembly-tool",
      definition: formatAgentDefinition({
        id: "assembly-tool-agent",
        model: registration.getModel(),
        instructions: ["Inspect before answering."],
        toolNames: ["inspect_runtime"]
      }),
      resolveApiKey: () => "core-only-key"
    });

    assert.deepEqual(assembly.tools.map((tool) => tool.name), ["inspect_runtime"]);
    assert.deepEqual(assembly.promptPlan.toolSnippets, {
      inspect_runtime: "Inspect runtime topics."
    });
    assert.deepEqual(assembly.promptPlan.toolGuidelines, [
      "Use inspect_runtime before answering runtime questions."
    ]);
    assert.equal(
      assembly.systemPrompt,
      [
        "Inspect before answering.",
        "Available tools:\n- inspect_runtime: Inspect runtime topics.",
        "Guidelines:\n- Use inspect_runtime before answering runtime questions."
      ].join("\n\n")
    );
  assert.deepEqual(assembly.toolPlan.entries.map((entry) => ({
    name: entry.name,
    label: entry.label,
    description: entry.description
  })), [{
    name: "inspect_runtime",
    label: "Inspect Runtime",
    description: "Inspect a runtime topic."
  }]);
  assert.deepEqual(assembly.toolPlan.toolInfos.map((tool) => ({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    promptSnippet: tool.promptSnippet,
    promptGuidelines: tool.promptGuidelines,
    sourceInfo: tool.sourceInfo
  })), [{
    name: "inspect_runtime",
    label: "Inspect Runtime",
    description: "Inspect a runtime topic.",
    promptSnippet: "Inspect runtime topics.",
    promptGuidelines: ["Use inspect_runtime before answering runtime questions."],
    sourceInfo: { source: "sdk", label: "Test SDK" }
  }]);
  } finally {
    registration.unregister();
  }
});

test("resolves resources through the resource catalog", () => {
  const registration = registerFauxProvider({ provider: "runtime-assembler-resource-test" });
  const runtimeNotes = createRuntimeNotesResource();
  const assembler = new RuntimeAssembler({
    resourceRegistry: createAgentResourceRegistry([runtimeNotes])
  });

  try {
    const assembly = assembler.assemble({
      sessionId: "session-assembly-resource",
      definition: formatAgentDefinition({
        id: "assembly-resource-agent",
        model: registration.getModel(),
        instructions: ["Use configured resources."],
        toolNames: [],
        resourceNames: ["runtime_notes"]
      }),
      resolveApiKey: () => "core-only-key"
    });

    assert.deepEqual(assembly.resources.resourceNames, ["runtime_notes"]);
    assert.deepEqual(assembly.resources.promptFragments, [
      "Runtime notes:\n- ResourceCatalog v1 injects static prompt fragments."
    ]);
    assert.deepEqual(assembly.resources.resourceInfos, [{
      name: "runtime_notes",
      label: "Runtime Notes",
      sourceInfo: { source: "sdk", label: "Test SDK" }
    }]);
    assert.equal(
      assembly.systemPrompt,
      [
        "Use configured resources.",
        "Runtime notes:\n- ResourceCatalog v1 injects static prompt fragments."
      ].join("\n\n")
    );
  } finally {
    registration.unregister();
  }
});

test("resource catalog rejects duplicate requested resources before registry lookup", () => {
  const runtimeNotes = createRuntimeNotesResource();
  const catalog = new ResourceCatalog(createAgentResourceRegistry([runtimeNotes]));

  assert.throws(
    () => catalog.resolve(["runtime_notes", " runtime_notes "]),
    /ResourceCatalog\.resourceNames contains duplicate resource name: runtime_notes/
  );
});

test("resource catalog exposes source info without runtime objects", () => {
  const runtimeNotes = defineAgentResource({
    ...createRuntimeNotesResource(),
    label: " Runtime Notes ",
    promptFragment: " Runtime notes:\n- Trimmed static fragment. ",
    sourceInfo: { source: "sdk", label: " SDK " }
  });
  const catalog = new ResourceCatalog(createAgentResourceRegistry([runtimeNotes]));

  const plan = catalog.resolvePlan({ resourceNames: ["runtime_notes"] });
  const allResources = catalog.getAllResources();
  const allResourceInfos = catalog.getAllResourceInfos();
  const runtimeNotesEntry = catalog.getResourceDefinition(" runtime_notes ");
  const runtimeNotesInfo = catalog.getResourceInfo(" runtime_notes ");

  assert.equal(plan.entries[0]?.promptFragment, "Runtime notes:\n- Trimmed static fragment.");
  assert.deepEqual(plan.entries[0]?.sourceInfo, { source: "sdk", label: "SDK" });
  assert.deepEqual(allResources.map((entry) => entry.name), ["runtime_notes"]);
  assert.deepEqual(allResourceInfos.map((resource) => resource.name), ["runtime_notes"]);
  assert.equal(runtimeNotesEntry?.name, "runtime_notes");
  assert.equal(runtimeNotesEntry?.promptFragment, "Runtime notes:\n- Trimmed static fragment.");
  assert.equal(runtimeNotesInfo?.name, "runtime_notes");
  assert.equal("promptFragment" in (runtimeNotesInfo ?? {}), false);
});

test("rejects unknown resources during assembly", () => {
  const registration = registerFauxProvider({ provider: "runtime-assembler-missing-resource-test" });
  const assembler = new RuntimeAssembler({
    resourceRegistry: createAgentResourceRegistry([])
  });

  try {
    assert.throws(
      () => assembler.assemble({
        sessionId: "session-assembly-missing-resource",
        definition: formatAgentDefinition({
          id: "assembly-missing-resource-agent",
          model: registration.getModel(),
          instructions: ["Use configured resources only."],
          toolNames: [],
          resourceNames: ["missing_resource"]
        }),
        resolveApiKey: () => "core-only-key"
      }),
      /does not contain resource: missing_resource/
    );
  } finally {
    registration.unregister();
  }
});

test("tool catalog rejects duplicate requested tools before registry lookup", () => {
  const inspectTool = createInspectTool();
  const catalog = new ToolCatalog(createAgentToolRegistry([inspectTool]));

  assert.throws(
    () => catalog.resolve(["inspect_runtime", " inspect_runtime "]),
    /ToolCatalog\.toolNames contains duplicate tool name: inspect_runtime/
  );
});

test("tool catalog applies tool enablement rules", () => {
  const inspectTool = createInspectTool();
  const catalog = new ToolCatalog(
    createAgentToolRegistry([inspectTool]),
    [({ toolName }) => ({
      enabled: toolName !== "inspect_runtime",
      reason: "not enabled for this definition"
    })]
  );

  assert.throws(
    () => catalog.resolve(["inspect_runtime"]),
    /ToolCatalog tool is disabled: inspect_runtime: not enabled for this definition/
  );
});

test("tool catalog exposes prompt metadata and source info from tool definitions", () => {
  const inspectTool = defineAgentTool({
    ...createInspectTool(),
    promptSnippet: " Inspect runtime\nstate ",
    promptGuidelines: [
      " Use inspect before answering. ",
      "Use inspect before answering.",
      "Report concise findings."
    ],
    sourceInfo: { source: "sdk", label: "SDK" }
  });
  const catalog = new ToolCatalog(createAgentToolRegistry([inspectTool]));

  const plan = catalog.resolvePlan({ toolNames: ["inspect_runtime"] });

  assert.equal(plan.entries[0]?.promptSnippet, "Inspect runtime state");
  assert.deepEqual(plan.entries[0]?.promptGuidelines, [
    "Use inspect before answering.",
    "Report concise findings."
  ]);
  assert.deepEqual(plan.entries[0]?.sourceInfo, { source: "sdk", label: "SDK" });
  assert.equal(plan.entries[0]?.tool.name, "inspect_runtime");
});

test("wraps tool definitions into runtime tools without prompt metadata", () => {
  const inspectTool = createInspectTool();

  const runtimeTool = wrapAgentToolDefinition(inspectTool);

  assert.equal(runtimeTool.name, "inspect_runtime");
  assert.equal(runtimeTool.label, "Inspect Runtime");
  assert.equal(runtimeTool.description, "Inspect a runtime topic.");
  assert.equal("promptSnippet" in runtimeTool, false);
  assert.equal("promptGuidelines" in runtimeTool, false);
  assert.equal("sourceInfo" in runtimeTool, false);
});

test("tool catalog exposes all registered tool definitions as normalized entries", () => {
  const inspectTool = createInspectTool();
  const catalog = new ToolCatalog(createAgentToolRegistry([inspectTool]));

  const allTools = catalog.getAllTools();
  const allToolInfos = catalog.getAllToolInfos();
  const inspectEntry = catalog.getToolDefinition(" inspect_runtime ");
  const inspectInfo = catalog.getToolInfo(" inspect_runtime ");
  const missingEntry = catalog.getToolDefinition("missing_tool");
  const missingInfo = catalog.getToolInfo("missing_tool");

  assert.deepEqual(allTools.map((entry) => entry.name), ["inspect_runtime"]);
  assert.deepEqual(allToolInfos.map((tool) => tool.name), ["inspect_runtime"]);
  assert.equal(inspectEntry?.name, "inspect_runtime");
  assert.equal(inspectEntry?.promptSnippet, "Inspect runtime topics.");
  assert.deepEqual(inspectEntry?.sourceInfo, { source: "sdk", label: "Test SDK" });
  assert.equal(inspectInfo?.name, "inspect_runtime");
  assert.equal(inspectInfo?.promptSnippet, "Inspect runtime topics.");
  assert.equal("tool" in (inspectInfo ?? {}), false);
  assert.equal(missingEntry, undefined);
  assert.equal(missingInfo, undefined);
});

test("rejects unknown tools during assembly", () => {
  const registration = registerFauxProvider({ provider: "runtime-assembler-missing-tool-test" });
  const assembler = new RuntimeAssembler({
    toolRegistry: createAgentToolRegistry([])
  });

  try {
    assert.throws(
      () => assembler.assemble({
        sessionId: "session-assembly-missing-tool",
        definition: formatAgentDefinition({
          id: "assembly-missing-tool-agent",
          model: registration.getModel(),
          instructions: ["Use configured tools only."],
          toolNames: ["missing_tool"]
        }),
        resolveApiKey: () => "core-only-key"
      }),
      /does not contain tool: missing_tool/
    );
  } finally {
    registration.unregister();
  }
});

test("model gateway triggers onApiKeyResolved when a key is returned", async () => {
  const registration = registerFauxProvider({ provider: "runtime-assembler-api-key-test" });
  const assembler = new RuntimeAssembler();
  let resolvedCount = 0;

  try {
    const assembly = assembler.assemble({
      sessionId: "session-assembly-api-key",
      definition: formatAgentDefinition({
        id: "assembly-api-key-agent",
        model: registration.getModel(),
        instructions: ["Answer briefly."],
        toolNames: []
      }),
      resolveApiKey: (provider) => provider === registration.getModel().provider ? "core-only-key" : undefined,
      onApiKeyResolved: () => {
        resolvedCount += 1;
      }
    });

    assert.equal(await assembly.getApiKey(registration.getModel().provider), "core-only-key");
    assert.equal(await assembly.getApiKey("other-provider"), undefined);
    assert.equal(resolvedCount, 1);
  } finally {
    registration.unregister();
  }
});

const inspectParameters = Type.Object({
  topic: Type.String()
});

function createInspectTool(): AgentToolDefinition<typeof inspectParameters> {
  return defineAgentTool({
    name: "inspect_runtime",
    label: "Inspect Runtime",
    description: "Inspect a runtime topic.",
    promptSnippet: "Inspect runtime topics.",
    promptGuidelines: ["Use inspect_runtime before answering runtime questions."],
    sourceInfo: { source: "sdk", label: "Test SDK" },
    parameters: inspectParameters,
    async execute(_toolCallId, params) {
      return { content: [{ type: "text", text: `Inspected ${params.topic}.` }], details: {} };
    }
  });
}

function readTextContent(message: AgentMessage): string {
  return "content" in message && typeof message.content === "string" ? message.content : "";
}

function createRuntimeNotesResource(): AgentResourceDefinition {
  return defineAgentResource({
    name: "runtime_notes",
    label: "Runtime Notes",
    promptFragment: "Runtime notes:\n- ResourceCatalog v1 injects static prompt fragments.",
    sourceInfo: { source: "sdk", label: "Test SDK" }
  });
}
