import {
  formatAgentDefinition,
  resolveAgentInstructionParts,
  type AgentDefinition
} from "./agent-definition.js";
import type { AgentModel } from "../contracts.js";
import type { AgentResourceName, AgentToolName } from "./agent-definition.js";

export type ResolvedAgentDefinition = {
  definition: AgentDefinition;
  id: string;
  model: AgentModel;
  toolNames: readonly AgentToolName[];
  resourceNames: readonly AgentResourceName[];
  instructionParts: readonly string[];
  instructionText: string;
};

export class DefinitionResolver {
  resolve(definition: AgentDefinition): ResolvedAgentDefinition {
    const formattedDefinition = formatAgentDefinition(definition);
    const instructionParts = resolveAgentInstructionParts(formattedDefinition);
    return {
      definition: formattedDefinition,
      id: formattedDefinition.id,
      model: formattedDefinition.model,
      toolNames: formattedDefinition.toolNames,
      resourceNames: formattedDefinition.resourceNames ?? [],
      instructionParts,
      instructionText: instructionParts.join(" ")
    };
  }
}
