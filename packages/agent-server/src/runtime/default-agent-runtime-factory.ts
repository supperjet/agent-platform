import {
  PiAgentRuntimeFactory,
  formatAgentDefinition,
  type AgentModel,
  type AgentDefinition,
  type AgentRuntimeEventListener,
  type AgentRuntimeFactory
} from "@agent-platform/agent-core";
import { createDeepSeekRuntime } from "./deepseek.js";
 
function createDefaultAgentDefinition(model: AgentModel): AgentDefinition {
  return formatAgentDefinition({
    id: "default-source-agent",
    model,
    instructions: [
      "You are a helpful assistant.",
      "Answer concisely in Chinese."
    ],
    toolNames: []
  });
}

export type AgentProviderRuntime = {
  model: AgentModel;
  resolveApiKey: (provider: string) => string | undefined | Promise<string | undefined>;
  onApiKeyResolved?: () => void;
};

export type DefaultAgentRuntimeFactoryOptions = {
  providerRuntime?: AgentProviderRuntime;
  onEvent?: AgentRuntimeEventListener;
};

export function createDefaultAgentRuntimeFactory(
  options: DefaultAgentRuntimeFactoryOptions = {}
): AgentRuntimeFactory {
  const providerRuntime: AgentProviderRuntime = options.providerRuntime ?? createDeepSeekRuntime();

  return new PiAgentRuntimeFactory({
    definition: createDefaultAgentDefinition(providerRuntime.model),
    resolveApiKey: providerRuntime.resolveApiKey,
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
    ...(providerRuntime.onApiKeyResolved
      ? { onApiKeyResolved: providerRuntime.onApiKeyResolved }
      : {})
  });
}
