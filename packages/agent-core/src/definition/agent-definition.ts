import type { AgentModel } from "../contracts.js";

export type AgentPromptVariables = Readonly<Record<string, string>>;
export type AgentToolName = string;
export type AgentResourceName = string;

export type AgentInstructionTemplate = {
  variables?: AgentPromptVariables;
  render: (variables: AgentPromptVariables) => readonly string[];
};

export type AgentInstructions =
  | readonly string[]
  | AgentInstructionTemplate;

export type AgentDefinition = {
  id: string; // Agent 长期定义的身份标识
  model: AgentModel; // 定义的模型，用于指定使用哪个模型来执行任务
  instructions: AgentInstructions; // 定义的指令，用于指定如何执行任务
  toolNames: readonly AgentToolName[]; // 定义的工具名称，用于指定可以使用哪些工具来执行任务
  resourceNames?: readonly AgentResourceName[]; // 定义依赖的静态资源名称，用于装配 prompt fragments
};

// 格式化AgentDefinition
export function formatAgentDefinition(definition: AgentDefinition): AgentDefinition {
  // 验证AgentDefinition的id是否为空
  assertNonBlank("AgentDefinition.id", definition.id);
  assertValidModel(definition.model);
  // 验证AgentDefinition的instructions
  validateAgentInstructions(definition.instructions);
  // 验证AgentDefinition的toolNames
  assertUniqueToolNames(definition.toolNames);
  assertUniqueResourceNames(definition.resourceNames ?? []);
  return {
    id: definition.id.trim(),
    model: definition.model,
    instructions: normalizeAgentInstructions(definition.instructions),
    toolNames: definition.toolNames.map((name) => name.trim()),
    resourceNames: (definition.resourceNames ?? []).map((name) => name.trim())
  };
}

// 解析AgentDefinition的instructions
export function resolveAgentInstructions(definition: AgentDefinition): string {
  return resolveAgentInstructionParts(definition).join(" ");
}

export function resolveAgentInstructionParts(definition: AgentDefinition): readonly string[] {
  const instructions = isAgentInstructionTemplate(definition.instructions)
    ? definition.instructions.render(resolvePromptVariables(definition.instructions))
    : definition.instructions;
  return normalizeInstructions(instructions);
}

function validateAgentInstructions(instructions: AgentInstructions) {
  if (!isAgentInstructionTemplate(instructions)) {
    normalizeInstructions(instructions);
    return;
  }

  const variables = instructions.variables ?? {};
  for (const [name, value] of Object.entries(variables)) {
    assertNonBlank("AgentDefinition.instructions.variables[]", name);
    assertNonBlank(`AgentDefinition.instructions.variables.${name}`, value);
  }

  normalizeInstructions(instructions.render(resolvePromptVariables(instructions)));
}

function normalizeAgentInstructions(instructions: AgentInstructions): AgentInstructions {
  if (isAgentInstructionTemplate(instructions)) return instructions;
  return normalizeInstructions(instructions);
}

function isAgentInstructionTemplate(instructions: AgentInstructions): instructions is AgentInstructionTemplate {
  return !Array.isArray(instructions);
}

function resolvePromptVariables(template: AgentInstructionTemplate): AgentPromptVariables {
  const definitions = template.variables ?? {};
  const resolved: Record<string, string> = {};

  for (const [name, value] of Object.entries(definitions)) {
    assertNonBlank(`AgentDefinition.instructions.variables.${name}`, value);
    resolved[name] = value;
  }

  return resolved;
}

function normalizeInstructions(instructions: readonly string[]): readonly string[] {
  const normalized = instructions.map((instruction, index) => {
    assertNonBlank(`AgentDefinition.instructions[${index}]`, instruction);
    return instruction.trim();
  });

  if (normalized.length === 0) {
    throw new Error("AgentDefinition.instructions must contain at least one instruction.");
  }

  return normalized;
}

function assertUniqueToolNames(toolNames: readonly AgentToolName[]) {
  const names = new Set<string>();

  for (const name of toolNames) {
    assertNonBlank("AgentDefinition.toolNames[]", name);
    if (names.has(name)) {
      throw new Error(`AgentDefinition.toolNames contains duplicate tool name: ${name}`);
    }
    names.add(name);
  }
}

function assertUniqueResourceNames(resourceNames: readonly AgentResourceName[]) {
  const names = new Set<string>();

  for (const name of resourceNames) {
    assertNonBlank("AgentDefinition.resourceNames[]", name);
    const normalizedName = name.trim();
    if (names.has(normalizedName)) {
      throw new Error(`AgentDefinition.resourceNames contains duplicate resource name: ${normalizedName}`);
    }
    names.add(normalizedName);
  }
}

function assertNonBlank(field: string, value: string) {
  if (value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
}

function assertValidModel(model: AgentModel) {
  if (!model || typeof model !== "object") {
    throw new Error("AgentDefinition.model must be a model object.");
  }
  assertNonBlank("AgentDefinition.model.id", model.id);
  assertNonBlank("AgentDefinition.model.provider", model.provider);
}
