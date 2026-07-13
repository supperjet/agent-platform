import {
  AgentRuntimeFactory,
  type AgentConversationState,
  type AgentRuntimeEventListener
} from "../contracts.js";
import type { AgentDefinition } from "../definition/agent-definition.js";
import type { AgentResourceRegistry } from "../resources/resource-catalog.js";
import type { AgentToolRegistry } from "../tools/tool-registry.js";
import { AgentLoopAdapter } from "./agent-loop-adapter.js";
import { AgentRuntimeSession } from "./agent-runtime-session.js";
import { RuntimeAssembler } from "./runtime-assembler.js";

export { AgentRuntimeSession, AgentRuntimeSession as PiAgentRuntime } from "./agent-runtime-session.js";

export type PiAgentRuntimeFactoryOptions = {
  definition: AgentDefinition;
  resourceRegistry?: AgentResourceRegistry;
  toolRegistry?: AgentToolRegistry;
  resolveApiKey: (provider: string) => string | undefined | Promise<string | undefined>;
  onApiKeyResolved?: () => void;
  onEvent?: AgentRuntimeEventListener;
};

export class PiAgentRuntimeFactory extends AgentRuntimeFactory {
  constructor(private readonly options: PiAgentRuntimeFactoryOptions) {
    super();
  }

  create(sessionId: string, state?: AgentConversationState) {
    const assembler = new RuntimeAssembler({
      ...(this.options.resourceRegistry ? { resourceRegistry: this.options.resourceRegistry } : {}),
      ...(this.options.toolRegistry ? { toolRegistry: this.options.toolRegistry } : {})
    });
    const assembly = assembler.assemble({
      sessionId,
      definition: this.options.definition,
      ...(state ? { state } : {}),
      resolveApiKey: this.options.resolveApiKey,
      ...(this.options.onApiKeyResolved ? { onApiKeyResolved: this.options.onApiKeyResolved } : {})
    });
    const loop = new AgentLoopAdapter({
      systemPrompt: assembly.systemPrompt,
      model: assembly.model,
      messages: assembly.messages,
      tools: assembly.tools,
      getApiKey: assembly.getApiKey
    });
    const runtime = new AgentRuntimeSession(sessionId, loop, assembly.conversation, assembly.messages.length);

    if (this.options.onEvent) {
      runtime.subscribe(this.options.onEvent);
    }
    return runtime;
  }
}
