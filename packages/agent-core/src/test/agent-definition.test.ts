import assert from "node:assert/strict";
import test from "node:test";
import { registerFauxProvider } from "@earendil-works/pi-ai";
import {
  DefinitionResolver,
  formatAgentDefinition,
  resolveAgentInstructions
} from "../index.js";

test("resolves static AgentDefinition instructions into a system prompt", () => {
  const registration = registerFauxProvider({ provider: "definition-test" });
  const definition = formatAgentDefinition({
    id: "test-agent",
    model: registration.getModel(),
    instructions: [
      " Answer in Chinese. ",
      "Do not expose secrets."
    ],
    toolNames: []
  });

  assert.equal(
    resolveAgentInstructions(definition),
    "Answer in Chinese. Do not expose secrets."
  );
  registration.unregister();
});

test("resolves contextual AgentDefinition instructions with prompt variables", () => {
  const registration = registerFauxProvider({ provider: "definition-context-test" });
  const definition = formatAgentDefinition({
    id: "contextual-agent",
    model: registration.getModel(),
    instructions: {
      variables: {
        audience: "developer"
      },
      render: ({ audience }) => [
        `You are assisting a ${audience}.`,
        "Use the configured tools only."
      ]
    },
    toolNames: []
  });

  assert.equal(
    resolveAgentInstructions(definition),
    "You are assisting a developer. Use the configured tools only."
  );
  registration.unregister();
});

test("rejects blank AgentDefinition prompt variable values", () => {
  const registration = registerFauxProvider({ provider: "definition-blank-variable-test" });

  assert.throws(
    () => formatAgentDefinition({
      id: "blank-variable-agent",
      model: registration.getModel(),
      instructions: {
        variables: {
          audience: " "
        },
        render: ({ audience }) => [
          `You are assisting a ${audience}.`
        ]
      },
      toolNames: []
    }),
    /instructions\.variables\.audience must be a non-empty string/
  );
  registration.unregister();
});

test("rejects duplicate tool name references in an AgentDefinition", () => {
  const registration = registerFauxProvider({ provider: "definition-duplicate-tool-test" });

  assert.throws(
    () => formatAgentDefinition({
      id: "duplicate-agent",
      model: registration.getModel(),
      instructions: ["Use tools safely."],
      toolNames: ["duplicate_tool", "duplicate_tool"]
    }),
    /duplicate tool name: duplicate_tool/
  );
  registration.unregister();
});

test("rejects duplicate resource name references in an AgentDefinition", () => {
  const registration = registerFauxProvider({ provider: "definition-duplicate-resource-test" });

  assert.throws(
    () => formatAgentDefinition({
      id: "duplicate-resource-agent",
      model: registration.getModel(),
      instructions: ["Use resources safely."],
      toolNames: [],
      resourceNames: ["runtime_notes", " runtime_notes "]
    }),
    /duplicate resource name: runtime_notes/
  );
  registration.unregister();
});

test("normalizes AgentDefinition identity, tools, resources, and instructions", () => {
  const registration = registerFauxProvider({ provider: "definition-normalize-test" });

  try {
    const resolved = new DefinitionResolver().resolve({
      id: " normalize-agent ",
      model: registration.getModel(),
      instructions: [
        " Answer with sources. ",
        " Stay concise. "
      ],
      toolNames: [" inspect_runtime "],
      resourceNames: [" runtime_notes "]
    });

    assert.equal(resolved.id, "normalize-agent");
    assert.deepEqual(resolved.instructionParts, ["Answer with sources.", "Stay concise."]);
    assert.equal(resolved.instructionText, "Answer with sources. Stay concise.");
    assert.deepEqual(resolved.toolNames, ["inspect_runtime"]);
    assert.deepEqual(resolved.resourceNames, ["runtime_notes"]);
    assert.equal(resolved.definition.id, "normalize-agent");
  } finally {
    registration.unregister();
  }
});

test("rejects invalid AgentDefinition model objects", () => {
  assert.throws(
    () => formatAgentDefinition({
      id: "invalid-model-agent",
      model: { id: " ", provider: "definition-invalid-model-test" } as never,
      instructions: ["Answer briefly."],
      toolNames: []
    }),
    /AgentDefinition\.model\.id must be a non-empty string/
  );
});
