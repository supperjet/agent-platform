import {
  AgentRuntimeFactory,
  type AgentConversationState,
  type AgentRuntimeEventListener,
} from "../contracts.js";
import type { AgentDefinition } from "../definition/agent-definition.js";
import type { AgentResourceRegistry } from "../resources/resource-catalog.js";
import type { PromptTemplateRegistry } from "../prompt/prompt-template.js";
import type { SkillRegistry } from "../skills/skill-loader.js";
import type { AgentToolRegistry } from "../tools/tool-registry.js";
import type { ToolRuntime } from "../tools/tool-runtime.js";
import type { LifecycleHooks } from "../lifecycle/lifecycle-hooks.js";
import type { RuntimePolicies } from "../policies/runtime-policies.js";
import type { ConversationSummarizer } from "../conversation/conversation-compactor.js";
import { createLifecycleRunner } from "../lifecycle/lifecycle-runner.js";
import { createContextBudgetForModel } from "../context/context-budget.js";
import { AgentLoopAdapter } from "./agent-loop-adapter.js";
import { AgentRuntimeSession } from "./agent-runtime-session.js";
import { RuntimeAssembler } from "./runtime-assembler.js";
import type { RuntimeAssemblerOptions } from "./runtime-assembler.js";

/**
 * 创建 PiAgentRuntimeFactory 所需的外部依赖。
 *
 * Factory 是 core 的 composition root 之一：调用方传入 agent definition、
 * registry 和凭据解析函数，Factory 负责在 create(...) 时组装成可执行 runtime。
 */
export type PiAgentRuntimeFactoryOptions = {
  /** 当前 factory 固定使用的 AgentDefinition。 */
  definition: AgentDefinition;
  /** 可选资源注册表；未传入时只使用空资源集合。 */
  resourceRegistry?: AgentResourceRegistry;
  /** 可选工具注册表；未传入时只使用空工具集合。 */
  toolRegistry?: AgentToolRegistry;
  /** 可选 prompt template registry；用于输入阶段渲染模板并注入本轮 messages。 */
  promptTemplateRegistry?: PromptTemplateRegistry;
  /** 可选 skill registry；用于输入阶段激活 skill 并注入本轮 messages。 */
  skillRegistry?: SkillRegistry;
  /** 可选工具运行时；用于注入 policy、approval、生命周期监听等执行控制能力。 */
  toolRuntime?: ToolRuntime;
  /** 可选内部生命周期 hooks；由 factory 接入 TurnRunner 和默认 ToolRuntime。 */
  lifecycleHooks?: LifecycleHooks;
  /** 可选运行时策略；默认保持 queue direct / retry none / compaction disabled。 */
  policies?: RuntimePolicies;
  /** 可选会话压缩摘要器；用于把 compaction plan 选出的原始 messages 压成 summary。 */
  conversationSummarizer?: ConversationSummarizer;
  /** Provider HTTP request timeout in milliseconds. */
  requestTimeoutMs?: number;
  /** Provider API key 解析函数，避免 key 进入 client/public event。 */
  resolveApiKey: (
    provider: string,
  ) => string | undefined | Promise<string | undefined>;
  /** 当 API key 被成功解析时触发，可用于诊断或懒加载提示。 */
  onApiKeyResolved?: () => void;
  /** 订阅创建出来的 runtime 的公共事件流。 */
  onEvent?: AgentRuntimeEventListener;
};

/**
 * 基于 pi-agent-core 的 AgentRuntimeFactory 实现。
 *
 * 这个类把一次 create(sessionId, state) 拆成三步：
 * 1. RuntimeAssembler 解析 definition/resources/tools/model/conversation。
 * 2. AgentLoopAdapter 创建底层 pi-agent-core AgentLoop。
 * 3. AgentRuntimeSession 包住 loop，提供 agent-core 的公共 Runtime 接口。
 */
export class PiAgentRuntimeFactory extends AgentRuntimeFactory {
  constructor(private readonly options: PiAgentRuntimeFactoryOptions) {
    super();
  }

  create(sessionId: string, state?: AgentConversationState) {
    // 组装运行时
    const assemblerParams: RuntimeAssemblerOptions = {};

    if (this.options.resourceRegistry) {
      assemblerParams.resourceRegistry = this.options.resourceRegistry;
    }
    if (this.options.toolRegistry) {
      assemblerParams.toolRegistry = this.options.toolRegistry;
    }
    if (this.options.toolRuntime || this.options.lifecycleHooks || this.options.policies) {
      assemblerParams.services = {
        ...(this.options.toolRuntime ? { toolRuntime: this.options.toolRuntime } : {}),
        ...(this.options.lifecycleHooks ? { lifecycleHooks: this.options.lifecycleHooks } : {}),
        ...(this.options.policies ? { policies: this.options.policies } : {}),
      };
    }

    const assembler = new RuntimeAssembler(assemblerParams);
    let runtime: AgentRuntimeSession | undefined;
    // 组装阶段会把工具包成 ToolRuntime wrapper；工具真正执行时，
    // 这个闭包会把 ToolRuntimeEvent 转发给当前 session 的 EventHub。
    const assembly = assembler.assemble({
      sessionId,
      definition: this.options.definition,
      ...(state ? { state } : {}),
      resolveApiKey: this.options.resolveApiKey,
      ...(this.options.onApiKeyResolved
        ? { onApiKeyResolved: this.options.onApiKeyResolved }
        : {}),
      onToolRuntimeEvent: (event) => {
        runtime?.publishToolRuntimeEvent(event);
      },
    });

    // 创建Agent循环适配器
    const loop = new AgentLoopAdapter({
      systemPrompt: assembly.systemPrompt,
      model: assembly.model,
      messages: assembly.messages,
      tools: assembly.tools,
      getApiKey: assembly.getApiKey,
      ...(this.options.requestTimeoutMs === undefined
        ? {}
        : { requestTimeoutMs: this.options.requestTimeoutMs }),
    });

    // 创建 Agent 运行时会话。这里 preferToolRuntimeEvents=true，
    // 表示公共工具事件优先来自 ToolRuntime，避免和 pi-agent-core 工具事件重复。
    runtime = new AgentRuntimeSession(
      sessionId,
      loop,
      assembly.conversation,
      assembly.messages.length,
      true,
      createLifecycleRunner(assembly.lifecycle),
      assembly.systemPrompt,
      {
        contextBudget: createContextBudgetForModel({
          provider: assembly.model.provider,
          modelId: assembly.model.id,
          maxContextTokens: assembly.model.contextWindow,
          maxOutputTokens: assembly.model.maxTokens,
        }),
        policies: assembly.policies,
        // summarizer 是会话级依赖：manual compact 与 automatic preflight compact
        // 都通过 AgentRuntimeSession 统一调用，factory 不参与具体 source selection。
        ...(this.options.conversationSummarizer
          ? { conversationSummarizer: this.options.conversationSummarizer }
          : {}),
        ...(this.options.promptTemplateRegistry
          ? { promptTemplateRegistry: this.options.promptTemplateRegistry }
          : {}),
        ...(this.options.skillRegistry
          ? { skillRegistry: this.options.skillRegistry }
          : {}),
      },
    );

    // 如果 factory 级别传入 onEvent，就自动订阅这个 runtime 的公共事件流。
    if (this.options.onEvent) {
      runtime.subscribe(this.options.onEvent);
    }
    return runtime;
  }
}
