import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { AgentConversationState, AgentModel } from "../contracts.js";
import type { AgentDefinition } from "../definition/agent-definition.js";
import {
  DefinitionResolver,
  type ResolvedAgentDefinition,
} from "../definition/definition-resolver.js";
import {
  ConversationStore,
  type ConversationRuntimeState,
} from "../conversation/conversation-store.js";
import {
  createDefaultLifecycleHooks,
  type LifecycleHooks,
} from "../lifecycle/lifecycle-hooks.js";
import { ModelCatalog } from "../model/model-catalog.js";
import { ModelGateway, type ApiKeyResolver } from "../model/model-gateway.js";
import {
  createDefaultRuntimePolicies,
  type RuntimePolicies,
} from "../policies/runtime-policies.js";
import {
  PromptAssembler,
  type PromptPlan,
} from "../prompt/prompt-assembler.js";
import {
  ResourceCatalog,
  type AgentResourceRegistry,
  type ResourceSnapshot,
} from "../resources/resource-catalog.js";
import {
  ToolCatalog,
  type ToolCatalogResolution,
} from "../tools/tool-catalog.js";
import type { AgentToolRegistry } from "../tools/tool-registry.js";
import {
  createToolRuntime,
  wrapToolsWithRuntime,
  type ToolRuntime,
} from "../tools/tool-runtime.js";

export type RuntimeAssemblyInput = {
  sessionId: string; // 会话ID，用于标识当前会话
  definition: AgentDefinition; // 执行任务的Agent定义
  state?: AgentConversationState; // 会话状态，用于恢复会话状态
  resolveApiKey: ApiKeyResolver; // 用于解析API密钥的函数
  onApiKeyResolved?: () => void; // 当API密钥解析完成时调用的回调函数
};

export type RuntimeAssembly = {
  definition: ResolvedAgentDefinition;
  model: AgentModel;
  promptPlan: PromptPlan;
  systemPrompt: string;
  resources: ResourceSnapshot;
  conversation: ConversationRuntimeState;
  messages: AgentMessage[];
  toolPlan: ToolCatalogResolution;
  tools: readonly AgentTool[];
  modelGateway: ModelGateway;
  getApiKey: (provider: string) => Promise<string | undefined>;
  lifecycle: LifecycleHooks;
  policies: RuntimePolicies;
};

export type RuntimeAssemblerServices = {
  definitionResolver: DefinitionResolver;
  resourceCatalog: ResourceCatalog;
  promptAssembler: PromptAssembler;
  toolCatalog: ToolCatalog;
  toolRuntime: ToolRuntime;
  conversationStore: ConversationStore;
  modelCatalog: ModelCatalog;
  lifecycleHooks: LifecycleHooks;
  policies: RuntimePolicies;
};

export type RuntimeAssemblerOptions = {
  services?: Partial<RuntimeAssemblerServices>;
  resourceRegistry?: AgentResourceRegistry;
  toolRegistry?: AgentToolRegistry;
};

export class RuntimeAssembler {
  private readonly services: RuntimeAssemblerServices;

  constructor(options: RuntimeAssemblerOptions = {}) {
    this.services = createRuntimeAssemblerServices(options);
  }

  assemble(input: RuntimeAssemblyInput): RuntimeAssembly {
    // 解析Agent定义
    const definition = this.services.definitionResolver.resolve(
      input.definition,
    );
    // 加载资源
    const resources = this.services.resourceCatalog.load({
      sessionId: input.sessionId,
      definition,
    });
    // 解析工具
    const toolPlan = this.services.toolCatalog.resolveForDefinition(definition);
    // 组装prompt
    const promptPlan = this.services.promptAssembler.assemble({
      definition,
      resources,
      toolPlan,
    });
    // 解析模型
    const model = this.services.modelCatalog.resolve(definition);
    // 恢复会话
    const conversation = this.services.conversationStore.restore({
      ...(input.state ? { state: input.state } : {}),
      modelId: model.id,
      definitionId: definition.id,
    });
    // 创建模型网关
    const modelGateway = new ModelGateway({
      resolveApiKey: input.resolveApiKey,
      ...(input.onApiKeyResolved
        ? { onApiKeyResolved: input.onApiKeyResolved }
        : {}),
    });

    const tools = wrapToolsWithRuntime(
      toolPlan.tools,
      this.services.toolRuntime,
      {
        sessionId: input.sessionId,
        definitionId: definition.id,
      },
    );

    return {
      definition,
      model,
      promptPlan,
      systemPrompt: promptPlan.systemPrompt,
      resources,
      conversation,
      messages: conversation.messages,
      toolPlan,
      tools,
      modelGateway,
      getApiKey: (provider) => modelGateway.getApiKey(provider),
      lifecycle: this.services.lifecycleHooks,
      policies: this.services.policies,
    };
  }
}

function createRuntimeAssemblerServices(
  options: RuntimeAssemblerOptions,
): RuntimeAssemblerServices {
  const defaultServices: RuntimeAssemblerServices = {
    definitionResolver: new DefinitionResolver(),
    resourceCatalog: new ResourceCatalog(options.resourceRegistry),
    promptAssembler: new PromptAssembler(),
    toolCatalog: new ToolCatalog(options.toolRegistry),
    toolRuntime: createToolRuntime({
      beforeToolCall: [
        // (input) => {
        //   if (input.tool.name === "read") {
        //     return {
        //       allow: false,
        //       reason: "read tool is not allowed.",
        //     };
        //   }
        //   return undefined;
        // },
      ],
      afterToolCall: [],
    }),
    conversationStore: new ConversationStore(),
    modelCatalog: new ModelCatalog(),
    lifecycleHooks: createDefaultLifecycleHooks(),
    policies: createDefaultRuntimePolicies(),
  };

  return {
    ...defaultServices,
    ...options.services,
  };
}
