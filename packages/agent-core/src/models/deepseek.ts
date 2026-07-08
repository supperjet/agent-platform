import { getModels } from "@earendil-works/pi-ai";
import type { AgentModel } from "../contracts.js";

export const DEFAULT_DEEPSEEK_MODEL_ID = "deepseek-v4-flash";

export function getDeepSeekModel(modelId: string): AgentModel {
  const models = getModels("deepseek");
  const model = models.find((candidate) => candidate.id === modelId);
  if (!model) {
    throw new Error(`Unknown DeepSeek model "${modelId}". Available: ${models.map((item) => item.id).join(", ")}`);
  }
  return model;
}

export function summarizeAgentModel(model: AgentModel) {
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    api: model.api,
    baseUrl: model.baseUrl,
    reasoning: model.reasoning,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens
  };
}
