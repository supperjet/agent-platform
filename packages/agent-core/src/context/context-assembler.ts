import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentRuntimeCommand } from "../contracts.js";
import type { LifecycleRunner } from "../lifecycle/lifecycle-runner.js";
import type { RenderedPromptTemplate } from "../prompt/prompt-template.js";
import { createUserMessage } from "../runtime/messages.js";
import type { SkillActivation, SkillScriptArgumentDefinition } from "../skills/skill-loader.js";
import {
  SKILL_READ_SUPPORT_FILE_TOOL_NAME,
  SKILL_RENDER_TEMPLATE_TOOL_NAME,
  SKILL_RUN_SCRIPT_TOOL_NAME,
} from "../skills/skill-tools.js";
import { ContextBudget, type ContextBudgetEstimate } from "./context-budget.js";

export type PromptRuntimeCommand = Extract<AgentRuntimeCommand, { type: "prompt" }>;

export type ContextAssemblerInput = {
  /** 当前 prompt 命令；第一版 ContextAssembler 只处理完整 prompt turn。 */
  command: PromptRuntimeCommand;
  /** 静态 PromptAssembler 产出的 base system prompt。 */
  baseSystemPrompt: string;
  /** 当前 conversation 投影出来的历史消息前缀。 */
  conversationMessages: readonly AgentMessage[];
  /** InputProcessor 输出的 per-turn scratch metadata，不默认进入 conversation state。 */
  metadata?: Record<string, unknown>;
};

export type TurnContextMetadata = {
  /** InputProcessor 与 lifecycle 合并后的本轮元数据，供后续 per-turn resolver 使用。 */
  turn?: Record<string, unknown>;
  /** beforeRun / beforeContext hook 写入的运行期元数据。 */
  hooks?: Record<string, unknown>;
  /** 上下文预算估算结果，只用于观测，不做裁剪。 */
  budget: ContextBudgetEstimate;
  /** 面向诊断和观测的上下文装配摘要。 */
  diagnostics: ContextAssemblyDiagnostics;
};

export type ContextAssemblyDiagnostics = {
  budget: ContextBudgetEstimate;
  injectedSources: string[];
  persistentPromptMessageCount: number;
  transientPromptMessageCount: number;
};

export type TurnContext = {
  /** 当前 turn 实际传给模型的 system prompt，可被 lifecycle 临时覆盖。 */
  systemPrompt: string;
  /** 当前 turn 需要追加给 AgentLoop 的消息，不包含已有 conversation 前缀。 */
  promptMessages: AgentMessage[];
  /** `promptMessages` 中应写回 conversation history 的消息下标。 */
  persistentPromptMessageIndexes: number[];
  /** `promptMessages` 中只给本轮模型调用使用、回合结束后应移除的消息下标。 */
  transientPromptMessageIndexes: number[];
  /** 当前 turn 组装时已有 conversation 前缀长度。 */
  conversationMessageCount: number;
  /** 包含 conversation 前缀和 promptMessages 的完整上下文视图。 */
  messages: readonly AgentMessage[];
  metadata: TurnContextMetadata;
};

export type ContextAssemblerOptions = {
  /** 生命周期执行器；ContextAssembler 负责 beforeRun / beforeContext 两个控制点。 */
  lifecycleRunner?: LifecycleRunner;
  /** 上下文预算估算器；默认使用保守 token 估算。 */
  contextBudget?: ContextBudget;
};

/**
 * ContextAssembler 是每个 prompt turn 的上下文装配中心。
 *
 * 执行流程：
 * 1. 把 prompt command 转换为标准 user message。
 * 2. 执行 lifecycle.beforeRun，允许追加 run 级消息和临时 systemPrompt。
 * 3. 拼出 conversation 历史前缀 + 本轮 prompt 消息，形成完整上下文视图。
 * 4. 执行 lifecycle.beforeContext，允许追加/改写本轮上下文和 systemPrompt。
 * 5. 校验 hook 没有移除或替换已有 conversation 前缀，再输出本轮要交给 AgentLoop 的消息。
 *
 * 注意：当前底层 AgentLoop.prompt 只接收“本轮新增消息”，已有历史由 loop 内部维护。
 * 因此 beforeContext 可以追加临时消息，但必须保留 conversationMessages 这个前缀。
 */
export class ContextAssembler {
  private readonly contextBudget: ContextBudget;

  constructor(private readonly options: ContextAssemblerOptions = {}) {
    this.contextBudget = options.contextBudget ?? new ContextBudget();
  }

  async assemble(input: ContextAssemblerInput): Promise<TurnContext> {
    const userMessage = createUserMessage(input.command.text);
    const skillMessage = createSkillMessage(input.metadata);
    const templateMessage = createTemplateMessage(input.metadata);
    const initialPromptMessages: AgentMessage[] = [
      ...(skillMessage ? [skillMessage] : []),
      ...(templateMessage ? [templateMessage] : []),
      userMessage,
    ];
    let systemPrompt = input.baseSystemPrompt;
    let promptMessages: AgentMessage[] = initialPromptMessages;
    let persistentPromptMessages: AgentMessage[] = [userMessage];
    let hookMetadata: Record<string, unknown> | undefined = input.metadata;
    const injectedSources: string[] = [
      ...(input.metadata ? ["input.metadata"] : []),
      ...(skillMessage ? ["skill.activation.message"] : []),
      ...(templateMessage ? ["prompt.template.message"] : []),
    ];

    const beforeRunResult = await this.options.lifecycleRunner?.beforeRun({
      command: input.command,
      systemPrompt,
      ...(hookMetadata ? { metadata: hookMetadata } : {}),
    });
    if (beforeRunResult?.systemPrompt !== undefined) {
      systemPrompt = beforeRunResult.systemPrompt;
      injectedSources.push("lifecycle.beforeRun.systemPrompt");
    }
    if (beforeRunResult?.messages?.length) {
      promptMessages = [...beforeRunResult.messages, ...initialPromptMessages];
      injectedSources.push("lifecycle.beforeRun.messages");
    }
    if (beforeRunResult?.metadata) {
      hookMetadata = mergeMetadata(hookMetadata, beforeRunResult.metadata);
      injectedSources.push("lifecycle.beforeRun.metadata");
    }

    let contextMessages: readonly AgentMessage[] = [
      ...input.conversationMessages,
      ...promptMessages,
    ];
    const beforeContextResult = await this.options.lifecycleRunner?.beforeContext({
      systemPrompt,
      messages: contextMessages,
      ...(hookMetadata ? { metadata: hookMetadata } : {}),
    });
    if (beforeContextResult?.systemPrompt !== undefined) {
      systemPrompt = beforeContextResult.systemPrompt;
      injectedSources.push("lifecycle.beforeContext.systemPrompt");
    }
    if (beforeContextResult?.messages !== undefined) {
      contextMessages = beforeContextResult.messages;
      promptMessages = projectPromptMessages(input.conversationMessages, contextMessages);
      persistentPromptMessages = projectPersistentPromptMessages(
        input.conversationMessages,
        contextMessages,
        persistentPromptMessages,
      );
      injectedSources.push("lifecycle.beforeContext.messages");
    }
    if (beforeContextResult?.metadata) {
      hookMetadata = mergeMetadata(hookMetadata, beforeContextResult.metadata);
      injectedSources.push("lifecycle.beforeContext.metadata");
    }
    const budget = this.contextBudget.estimate(contextMessages, { systemPrompt });
    const persistentPromptMessageIndexes = findPromptMessageIndexes(
      promptMessages,
      persistentPromptMessages,
    );
    const transientPromptMessageIndexes = promptMessages
      .map((_, index) => index)
      .filter((index) => !persistentPromptMessageIndexes.includes(index));

    return {
      systemPrompt,
      promptMessages,
      persistentPromptMessageIndexes,
      transientPromptMessageIndexes,
      conversationMessageCount: input.conversationMessages.length,
      messages: contextMessages,
      metadata: {
        ...(hookMetadata ? { turn: hookMetadata } : {}),
        ...(hookMetadata ? { hooks: hookMetadata } : {}),
        budget,
        diagnostics: {
          budget,
          injectedSources,
          persistentPromptMessageCount: persistentPromptMessageIndexes.length,
          transientPromptMessageCount: transientPromptMessageIndexes.length,
        },
      },
    };
  }
}

function projectPromptMessages(
  conversationMessages: readonly AgentMessage[],
  nextContextMessages: readonly AgentMessage[],
): AgentMessage[] {
  if (nextContextMessages.length < conversationMessages.length) {
    throw new Error("beforeContext cannot remove existing conversation messages in the current ContextAssembler wiring.");
  }

  for (let index = 0; index < conversationMessages.length; index++) {
    if (nextContextMessages[index] !== conversationMessages[index]) {
      throw new Error("beforeContext must preserve the existing conversation prefix in the current ContextAssembler wiring.");
    }
  }

  return nextContextMessages.slice(conversationMessages.length);
}

function projectPersistentPromptMessages(
  conversationMessages: readonly AgentMessage[],
  nextContextMessages: readonly AgentMessage[],
  previousPersistentMessages: readonly AgentMessage[],
): AgentMessage[] {
  const nextPromptMessages = projectPromptMessages(
    conversationMessages,
    nextContextMessages,
  );
  const nextPromptMessageSet = new Set(nextPromptMessages);
  for (const message of previousPersistentMessages) {
    if (!nextPromptMessageSet.has(message)) {
      throw new Error("beforeContext must preserve existing persistent prompt messages in the current ContextAssembler wiring.");
    }
  }
  return [...previousPersistentMessages];
}

function findPromptMessageIndexes(
  promptMessages: readonly AgentMessage[],
  persistentPromptMessages: readonly AgentMessage[],
): number[] {
  const remaining = [...persistentPromptMessages];
  return promptMessages.flatMap((message, index) => {
    const persistentIndex = remaining.indexOf(message);
    if (persistentIndex < 0) return [];
    remaining.splice(persistentIndex, 1);
    return [index];
  });
}

function mergeMetadata(
  currentMetadata: Record<string, unknown> | undefined,
  nextMetadata: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...currentMetadata,
    ...nextMetadata,
  };
}

function createTemplateMessage(
  metadata: Record<string, unknown> | undefined,
): AgentMessage | undefined {
  const renderedTemplate = readRenderedTemplate(metadata);
  if (!renderedTemplate) return undefined;
  return createUserMessage([
    `<prompt_template name="${escapeXmlAttribute(renderedTemplate.name)}" source="${escapeXmlAttribute(renderedTemplate.sourceInfo.label)}">`,
    renderedTemplate.content,
    "</prompt_template>",
  ].join("\n"));
}

function createSkillMessage(
  metadata: Record<string, unknown> | undefined,
): AgentMessage | undefined {
  const activation = readSkillActivation(metadata);
  if (!activation) return undefined;
  return createUserMessage([
    `<skill name="${escapeXmlAttribute(activation.name)}" source="${escapeXmlAttribute(activation.sourceInfo.label)}">`,
    activation.instructions,
    ...(activation.supportFiles?.length
      ? [
          "",
          "<available_support_files>",
          ...activation.supportFiles.flatMap((file) => [
            createSupportFileManifestLine(file),
            ...(file.template
              ? [createTemplateContractLine(file.template)]
              : []),
            ...(file.script?.args?.length
              ? file.script.args.map(createScriptArgumentContractLine)
              : []),
            ...(file.template || file.script?.args?.length ? [`</file>`] : []),
          ]),
          "</available_support_files>",
          ...createSupportFileToolsBlock(activation.supportFiles),
        ]
      : []),
    ...(activation.references?.length
      ? [
          "",
          "<references>",
          ...activation.references.flatMap((reference) => [
            `<reference source="${escapeXmlAttribute(reference.file.sourceInfo.label)}">`,
            reference.content,
            "</reference>",
          ]),
          "</references>",
        ]
      : []),
    ...(activation.templates?.length
      ? [
          "",
          "<templates>",
          ...activation.templates.flatMap((template) => [
            `<template name="${escapeXmlAttribute(template.name)}" source="${escapeXmlAttribute(template.sourceInfo.label)}">`,
            template.content,
            "</template>",
          ]),
          "</templates>",
        ]
      : []),
    ...(activation.diagnostics?.length
      ? [
          "",
          "<diagnostics>",
          ...activation.diagnostics.map((diagnostic) =>
            `<diagnostic type="${escapeXmlAttribute(diagnostic.type)}" code="${escapeXmlAttribute(diagnostic.code)}">${diagnostic.message}</diagnostic>`
          ),
          "</diagnostics>",
        ]
      : []),
    ...(activation.arguments
      ? [
          "",
          "<arguments>",
          activation.arguments,
          "</arguments>",
        ]
      : []),
    "</skill>",
  ].join("\n"));
}

function createSupportFileToolsBlock(
  supportFiles: readonly NonNullable<SkillActivation["supportFiles"]>[number][],
): string[] {
  const tools: string[] = [];
  if (supportFiles.some((file) => file.trustPolicy.canRead)) {
    tools.push(`<tool name="${SKILL_READ_SUPPORT_FILE_TOOL_NAME}" action="read" />`);
  }
  if (supportFiles.some((file) => file.kind === "template" && file.trustPolicy.canRead)) {
    tools.push(`<tool name="${SKILL_RENDER_TEMPLATE_TOOL_NAME}" action="render" />`);
  }
  if (supportFiles.some((file) => file.kind === "script" && file.trustPolicy.canExecute)) {
    tools.push(`<tool name="${SKILL_RUN_SCRIPT_TOOL_NAME}" action="run" />`);
  }
  if (tools.length === 0) return [];
  return [
    "",
    "<support_file_tools>",
    ...tools,
    "</support_file_tools>",
  ];
}

function readSkillActivation(
  metadata: Record<string, unknown> | undefined,
): SkillActivation | undefined {
  const value = metadata?.skillActivation;
  if (!value || typeof value !== "object") return undefined;
  const activation = value as Partial<SkillActivation>;
  if (typeof activation.name !== "string" || typeof activation.instructions !== "string") return undefined;
  if (!activation.sourceInfo || typeof activation.sourceInfo.label !== "string") return undefined;
  if (activation.arguments !== undefined && typeof activation.arguments !== "string") return undefined;
  if (activation.supportFiles !== undefined && !Array.isArray(activation.supportFiles)) return undefined;
  if (activation.references !== undefined && !Array.isArray(activation.references)) return undefined;
  if (activation.templates !== undefined && !Array.isArray(activation.templates)) return undefined;
  if (activation.diagnostics !== undefined && !Array.isArray(activation.diagnostics)) return undefined;
  return activation as SkillActivation;
}

function createSupportFileManifestLine(
  file: NonNullable<SkillActivation["supportFiles"]>[number],
): string {
  const attributes = [
    `kind="${escapeXmlAttribute(file.kind)}"`,
    `label="${escapeXmlAttribute(file.label)}"`,
    `source="${escapeXmlAttribute(file.sourceInfo.label)}"`,
    `read="${formatPolicyBoolean(file.trustPolicy.canRead)}"`,
    `inject="${formatPolicyBoolean(file.trustPolicy.canInject)}"`,
    `execute="${formatPolicyBoolean(file.trustPolicy.canExecute)}"`,
    `policy_reason="${escapeXmlAttribute(file.trustPolicy.reason)}"`,
    ...(file.script?.sandbox ? [`sandbox="${escapeXmlAttribute(file.script.sandbox)}"`] : []),
    ...(file.script?.interpreter ? [`interpreter="${escapeXmlAttribute(file.script.interpreter)}"`] : []),
    ...(file.script?.timeoutMs === undefined ? [] : [`timeout_ms="${file.script.timeoutMs}"`]),
    ...(file.script?.outputLimitBytes === undefined ? [] : [`output_limit_bytes="${file.script.outputLimitBytes}"`]),
  ];
  if (file.template || file.script?.args?.length) return `<file ${attributes.join(" ")}>`;
  return `<file ${attributes.join(" ")} />`;
}

function createTemplateContractLine(
  template: NonNullable<NonNullable<SkillActivation["supportFiles"]>[number]["template"]>,
): string {
  const variables = template.variableDefinitions?.map((variable) => variable.name).join(",") ?? "";
  const attributes = [
    `name="${escapeXmlAttribute(template.name)}"`,
    ...(template.description ? [`description="${escapeXmlAttribute(template.description)}"`] : []),
    ...(variables ? [`variables="${escapeXmlAttribute(variables)}"`] : []),
  ];
  return `<template_contract ${attributes.join(" ")} />`;
}

function createScriptArgumentContractLine(
  arg: SkillScriptArgumentDefinition,
): string {
  const attributes = [
    `name="${escapeXmlAttribute(arg.name)}"`,
    `type="${escapeXmlAttribute(arg.type)}"`,
    `required="${formatPolicyBoolean(Boolean(arg.required))}"`,
    ...(arg.description ? [`description="${escapeXmlAttribute(arg.description)}"`] : []),
  ];
  return `<arg ${attributes.join(" ")} />`;
}

function formatPolicyBoolean(value: boolean): "yes" | "no" {
  return value ? "yes" : "no";
}

function readRenderedTemplate(
  metadata: Record<string, unknown> | undefined,
): RenderedPromptTemplate | undefined {
  const value = metadata?.promptTemplate;
  if (!value || typeof value !== "object") return undefined;
  const template = value as Partial<RenderedPromptTemplate>;
  if (typeof template.name !== "string" || typeof template.content !== "string") return undefined;
  if (!template.sourceInfo || typeof template.sourceInfo.label !== "string") return undefined;
  return template as RenderedPromptTemplate;
}

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("\"", "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
