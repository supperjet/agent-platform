import { getModels } from "@earendil-works/pi-ai";
import type { AgentModel } from "../contracts.js";

export const DEFAULT_DEEPSEEK_MODEL_ID = "deepseek-v4-flash";

export function getDeepSeekModel(modelId: string = DEFAULT_DEEPSEEK_MODEL_ID): AgentModel {
  const models = getModels("deepseek");
  const model = models.find((candidate) => candidate.id === modelId);
  if (!model) {
    throw new Error(`Unknown DeepSeek model "${modelId}". Available: ${models.map((item) => item.id).join(", ")}`);
  }
  return model;
}

export function summarizeAgentModel(model: AgentModel): string {
  return `${model.provider}/${model.id}`;
}
