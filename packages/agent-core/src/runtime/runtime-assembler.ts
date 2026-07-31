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
import { createLifecycleRunner } from "../lifecycle/lifecycle-runner.js";
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
  type ToolRuntimeEventListener,
} from "../tools/tool-runtime.js";

/**
 * RuntimeAssembler 单次装配输入。
 *
 * 这些字段都是 session 级别的动态信息；静态依赖如 registry/catalog/service
 * 通过 RuntimeAssemblerOptions 注入。
 */
export type RuntimeAssemblyInput = {
  sessionId: string; // 会话ID，用于标识当前会话
  definition: AgentDefinition; // 执行任务的Agent定义
  state?: AgentConversationState; // 会话状态，用于恢复会话状态
  resolveApiKey: ApiKeyResolver; // 用于解析API密钥的函数
  onApiKeyResolved?: () => void; // 当API密钥解析完成时调用的回调函数
  onToolRuntimeEvent?: ToolRuntimeEventListener; // 工具生命周期事件监听器
};

/**
 * RuntimeAssembler 的完整装配结果。
 *
 * AgentRuntimeFactory 会从这里取出 system prompt、model、messages、tools，
 * 交给 AgentLoopAdapter 创建底层执行循环；其余对象保留给 runtime/session
 * 做状态导出、生命周期、策略或诊断。
 */
export type RuntimeAssembly = {
  /** 解析和规范化后的 agent definition。 */
  definition: ResolvedAgentDefinition;
  /** 当前 agent 使用的模型对象。 */
  model: AgentModel;
  /** prompt 装配计划，包含 system prompt 和资源/工具投影信息。 */
  promptPlan: PromptPlan;
  /** 最终注入底层 agent 的 system prompt。 */
  systemPrompt: string;
  /** 本次会话加载到的资源快照。 */
  resources: ResourceSnapshot;
  /** 恢复后的 conversation entry graph 状态。 */
  conversation: ConversationRuntimeState;
  /** 恢复后注入底层 agent 的线性消息历史。 */
  messages: AgentMessage[];
  /** 工具解析计划，保留 prompt metadata 和运行时工具投影。 */
  toolPlan: ToolCatalogResolution;
  /** 已经通过 ToolRuntime 包装过的可执行工具集合。 */
  tools: readonly AgentTool[];
  /** 模型网关，负责按 provider 解析 API key。 */
  modelGateway: ModelGateway;
  /** 供底层 AgentLoopAdapter 使用的 API key resolver。 */
  getApiKey: (provider: string) => Promise<string | undefined>;
  /** 会话生命周期 hook 集合。 */
  lifecycle: LifecycleHooks;
  /** 运行时策略集合。 */
  policies: RuntimePolicies;
};

/**
 * RuntimeAssembler 依赖的内部服务集合。
 *
 * 默认实现由 createRuntimeAssemblerServices 创建；测试或上层组合根可以替换
 * 其中任意服务，以便注入 fake catalog、custom ToolRuntime 或策略实现。
 */
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

/**
 * 创建 RuntimeAssembler 时的静态配置。
 */
export type RuntimeAssemblerOptions = {
  /** 覆盖默认内部服务，主要用于测试或高级组合。 */
  services?: Partial<RuntimeAssemblerServices>;
  /** 注入资源注册表，交给 ResourceCatalog 使用。 */
  resourceRegistry?: AgentResourceRegistry;
  /** 注入工具注册表，交给 ToolCatalog 使用。 */
  toolRegistry?: AgentToolRegistry;
};

/**
 * Agent runtime 装配器。
 *
 * 它不直接执行 agent，而是把一次 session 所需的所有材料装配好：
 * definition -> resources/tools -> prompt -> model -> conversation -> runtime tools。
 *
 * 这样 Factory 只关心“拿装配结果创建 AgentLoop 和 Session”，而各个 catalog/store
 * 的细节集中在这一层。
 */
export class RuntimeAssembler {
  private readonly services: RuntimeAssemblerServices;

  constructor(options: RuntimeAssemblerOptions = {}) {
    this.services = createRuntimeAssemblerServices(options);
  }

  assemble(input: RuntimeAssemblyInput): RuntimeAssembly {
    // 解析 Agent 定义，做 schema/重复项/默认值等规范化。
    const definition = this.services.definitionResolver.resolve(
      input.definition,
    );

    // 加载 definition 声明需要的资源，并形成 prompt 可用的快照。
    const resources = this.services.resourceCatalog.load({
      sessionId: input.sessionId,
      definition,
    });

    // 根据 definition.toolNames 解析可用工具，同时保留 prompt/debug 元数据。
    const toolPlan = this.services.toolCatalog.resolveForDefinition(definition);

    // 把 instructions、resources、tools 的模型提示合并为最终 system prompt。
    const promptPlan = this.services.promptAssembler.assemble({
      definition,
      resources,
      toolPlan,
    });

    // 解析模型配置，得到底层 pi-agent-core 可使用的模型对象。
    const model = this.services.modelCatalog.resolve(definition);

    // 恢复会话状态，并校验状态与当前 definition/model 是否兼容。
    const conversation = this.services.conversationStore.restore({
      ...(input.state ? { state: input.state } : {}),
      modelId: model.id,
      definitionId: definition.id,
    });

    // 创建模型网关，避免底层 agent 直接持有外部 resolveApiKey 实现。
    const modelGateway = new ModelGateway({
      resolveApiKey: input.resolveApiKey,
      ...(input.onApiKeyResolved
        ? { onApiKeyResolved: input.onApiKeyResolved }
        : {}),
    });

    // 把 Catalog 解析出的普通 AgentTool 包进 ToolRuntime。
    // 这样底层 agent 仍然看到标准工具接口，但每次调用都会经过生命周期层。
    const tools = wrapToolsWithRuntime(
      toolPlan.tools,
      this.services.toolRuntime,
      {
        sessionId: input.sessionId,
        definitionId: definition.id,
      },
      input.onToolRuntimeEvent,
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

/**
 * 创建 RuntimeAssembler 默认服务集合。
 *
 * 这里是 core 默认 runtime composition 的细粒度入口；Factory 只负责传入 registry，
 * 具体 catalog/store/runtime/policies 的默认实现都在这里集中创建。
 */
function createRuntimeAssemblerServices(
  options: RuntimeAssemblerOptions,
): RuntimeAssemblerServices {
  const lifecycleHooks = options.services?.lifecycleHooks ?? createDefaultLifecycleHooks();
  const defaultServices: RuntimeAssemblerServices = {
    definitionResolver: new DefinitionResolver(),
    resourceCatalog: new ResourceCatalog(options.resourceRegistry),
    promptAssembler: new PromptAssembler(),
    toolCatalog: new ToolCatalog(options.toolRegistry),
    toolRuntime: createToolRuntime({
      lifecycleRunner: createLifecycleRunner(lifecycleHooks),
    }),
    conversationStore: new ConversationStore(),
    modelCatalog: new ModelCatalog(),
    lifecycleHooks,
    policies: createDefaultRuntimePolicies(),
  };

  return {
    ...defaultServices,
    ...options.services,
  };
}
