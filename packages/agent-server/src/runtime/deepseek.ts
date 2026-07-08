import {
  DEFAULT_DEEPSEEK_MODEL_ID,
  getDeepSeekModel,
  summarizeAgentModel,
  type AgentModel
} from "@agent-platform/agent-core";

export { DEFAULT_DEEPSEEK_MODEL_ID };

export type DeepSeekRuntime = {
  model: AgentModel;
  apiKey: string;
  resolveApiKey(provider: string): string | undefined;
};

/** Loads all server-side DeepSeek configuration behind one reusable interface. */
export function createDeepSeekRuntime(
  modelId = process.env.DEEPSEEK_MODEL_ID ?? DEFAULT_DEEPSEEK_MODEL_ID
): DeepSeekRuntime {
  const apiKey = requireEnv("DEEPSEEK_API_KEY");
  const model = getDeepSeekModel(modelId);

  return {
    model,
    apiKey,
    resolveApiKey(provider) {
      return provider === "deepseek" ? apiKey : undefined;
    }
  };
}

export function requireEnv(name: string) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing ${name}. Add it to .env at the project root.`);
  }

  return value;
}

export const summarizeModel = summarizeAgentModel;
