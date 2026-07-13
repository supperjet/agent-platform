import type { AgentModel } from "../contracts.js";
import type { ResolvedAgentDefinition } from "../definition/definition-resolver.js";

export class ModelCatalog {
  resolve(definition: ResolvedAgentDefinition): AgentModel {
    return definition.model;
  }
}
