import { completeSimple, type AssistantMessage } from "@earendil-works/pi-ai/base";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentModel } from "../contracts.js";
import type { ApiKeyResolver } from "../model/model-gateway.js";
import type {
  ConversationSummarizer,
  ConversationSummarizerInput,
} from "./conversation-compactor.js";
import {
  summarizeConversationMessages,
} from "./conversation-compactor.js";

export type LlmConversationSummarizerFailureStrategy =
  | "fail-closed"
  | "fallback-summary";

export type LlmConversationSummarizerOutputFormat =
  | "text"
  | "structured-json";

export type StructuredConversationSummary = {
  readonly summary: string;
  readonly facts?: readonly string[];
  readonly decisions?: readonly string[];
  readonly openQuestions?: readonly string[];
  readonly currentTaskState?: readonly string[];
  readonly risks?: readonly string[];
};

export type LlmConversationSummarizerOptions = {
  readonly model: AgentModel;
  readonly resolveApiKey: ApiKeyResolver;
  /** 摘要失败时的处理方式。默认 fail-closed，避免把未知质量的摘要写入持久状态。 */
  readonly failureStrategy?: LlmConversationSummarizerFailureStrategy;
  /** 输出格式。text 兼容普通摘要；structured-json 会先校验结构再渲染成 summary 文本。 */
  readonly outputFormat?: LlmConversationSummarizerOutputFormat;
  /** 可覆盖默认压缩提示词；结构化模式会在该提示词后追加 JSON schema 约束。 */
  readonly systemPrompt?: string;
  /** 摘要器自身的输入预算，不等同于主对话 ContextBudget。超预算时不会调用 provider。 */
  readonly maxInputTokens?: number;
  readonly requestTimeoutMs?: number;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly sessionId?: string;
  readonly now?: () => number;
  readonly onApiKeyResolved?: () => void;
};

export class LlmConversationSummarizer implements ConversationSummarizer {
  constructor(private readonly options: LlmConversationSummarizerOptions) {}

  async summarize(input: ConversationSummarizerInput): Promise<string> {
    validateMaxInputTokens(this.options.maxInputTokens);
    try {
      // LLM 只负责“怎么总结”，不负责“压缩哪些 entry”。source selection 已经在
      // conversation-compactor / runtime policy 中完成，这样策略审计和生成行为不会混在一起。
      const systemPrompt = buildSystemPrompt(
        this.options.systemPrompt ?? DEFAULT_COMPACTION_SYSTEM_PROMPT,
        this.options.outputFormat ?? "text",
      );
      const prompt = buildCompactionPrompt(input);
      assertWithinInputBudget({
        maxInputTokens: this.options.maxInputTokens,
        systemPrompt,
        prompt,
      });

      const apiKey = await this.options.resolveApiKey(this.options.model.provider);
      if (apiKey) this.options.onApiKeyResolved?.();

      // 摘要调用不走 AgentLoop，也不会直接产生 message entry。只有成功解析出的
      // summary 会通过 compaction entry 写入 append-only conversation graph。
      const message = await completeSimple(this.options.model, {
        systemPrompt,
        messages: [{
          role: "user",
          content: prompt,
          timestamp: this.options.now?.() ?? Date.now(),
        }],
      }, {
        ...(apiKey ? { apiKey } : {}),
        ...(this.options.requestTimeoutMs === undefined ? {} : { timeoutMs: this.options.requestTimeoutMs }),
        ...(this.options.maxTokens === undefined ? {} : { maxTokens: this.options.maxTokens }),
        ...(this.options.temperature === undefined ? {} : { temperature: this.options.temperature }),
        ...(this.options.sessionId === undefined ? {} : { sessionId: this.options.sessionId }),
      });

      return readAssistantSummary(message, this.options.outputFormat ?? "text");
    } catch (error) {
      // fallback-summary 必须显式开启；默认 fail-closed 会继续抛错，让 runtime 放弃
      // 本次 compaction，避免静默产生一个质量未知的持久摘要。
      if ((this.options.failureStrategy ?? "fail-closed") === "fallback-summary") {
        return summarizeConversationMessages(input.sourceMessages, input.instructions);
      }
      throw error;
    }
  }
}

export function createLlmConversationSummarizer(
  options: LlmConversationSummarizerOptions,
): LlmConversationSummarizer {
  return new LlmConversationSummarizer(options);
}

const DEFAULT_COMPACTION_SYSTEM_PROMPT = [
  "You are a conversation compaction engine for an agent runtime.",
  "Summarize only the selected source messages into durable context for future turns.",
  "Preserve user requirements, decisions, constraints, tool results, unresolved questions, and current task state.",
  "Do not invent facts. Do not include messages that are only listed as preserved.",
  "Return only the compacted summary text.",
].join("\n");

const STRUCTURED_OUTPUT_INSTRUCTIONS = [
  "Return only valid JSON with this exact object shape:",
  "{",
  '  "summary": "short durable narrative summary",',
  '  "facts": ["stable facts the future agent should remember"],',
  '  "decisions": ["explicit decisions or accepted constraints"],',
  '  "openQuestions": ["unresolved questions or blockers"],',
  '  "currentTaskState": ["where the work currently stands"],',
  '  "risks": ["known risks, caveats, or validation gaps"]',
  "}",
  "Every property except summary may be an empty array. Do not wrap the JSON in markdown.",
].join("\n");

function buildSystemPrompt(
  systemPrompt: string,
  outputFormat: LlmConversationSummarizerOutputFormat,
): string {
  if (outputFormat === "text") return systemPrompt;
  // structured-json 是 summarizer 内部的模型输出协议，不是 conversation graph
  // schema。校验通过后仍会渲染成一段 summary 文本，保持 E.0 projection 语义不变。
  return [
    systemPrompt,
    "",
    STRUCTURED_OUTPUT_INSTRUCTIONS,
  ].join("\n");
}

function assertWithinInputBudget(input: {
  maxInputTokens: number | undefined;
  systemPrompt: string;
  prompt: string;
}) {
  if (input.maxInputTokens === undefined) return;
  const estimatedInputTokens = estimatePromptTokens(input.systemPrompt) + estimatePromptTokens(input.prompt);
  if (estimatedInputTokens <= input.maxInputTokens) return;
  throw new Error(
    `LLM conversation summarizer input budget exceeded: estimated ${estimatedInputTokens} tokens, max ${Math.floor(input.maxInputTokens)}.`,
  );
}

function validateMaxInputTokens(maxInputTokens: number | undefined) {
  if (maxInputTokens === undefined) return;
  if (!Number.isFinite(maxInputTokens) || maxInputTokens < 1) {
    throw new Error("LLM conversation summarizer maxInputTokens must be a positive number.");
  }
}

function estimatePromptTokens(text: string): number {
  if (!text) return 0;
  // 这里先使用轻量字符粗估，目标是防止摘要器 prompt 明显超过预算。
  // 后续接入 provider tokenizer 时，可以只替换这一处估算逻辑。
  return Math.ceil(text.length / 4) + 8;
}

function buildCompactionPrompt(input: ConversationSummarizerInput): string {
  // prompt 保留 source/preserved ids 与 stage audit，方便模型理解选择边界，也方便
  // 后续把一次压缩的“输入 -> 摘要 -> 投影结果”拿出来做效果评估。
  return [
    "Compress the following selected conversation messages.",
    "",
    `reason: ${input.reason}`,
    ...(input.instructions ? [`instructions: ${input.instructions}`] : []),
    `sourceEntryIds: ${JSON.stringify(input.sourceEntryIds)}`,
    `preservedEntryIds: ${JSON.stringify(input.preservedEntryIds)}`,
    "",
    "selection:",
    JSON.stringify({
      targetTokens: input.selection.targetTokens,
      estimatedTokensBefore: input.selection.estimatedTokensBefore,
      estimatedTokensAfterTarget: input.selection.estimatedTokensAfterTarget,
      selectedEstimatedTokens: input.selection.selectedEstimatedTokens,
      stageResults: input.selection.stageResults.map((stage) => ({
        stageIndex: stage.stageIndex,
        mode: stage.mode,
        selectedEntryIds: stage.selectedEntryIds,
        selectedEstimatedTokens: stage.selectedEstimatedTokens,
        totalSelectedEstimatedTokens: stage.totalSelectedEstimatedTokens,
        reachedTarget: stage.reachedTarget,
      })),
    }, null, 2),
    "",
    "selectedMessages:",
    JSON.stringify(input.sourceMessages.map((entry) => ({
      entryId: entry.id,
      createdAt: entry.createdAt,
      message: serializeAgentMessage(entry.payload.message),
    })), null, 2),
  ].join("\n");
}

function serializeAgentMessage(message: AgentMessage): unknown {
  // 传给摘要模型的是原始 selected message 的安全序列化版本。图片只暴露长度，
  // thinking 内容不透传，避免把不应长期保留的内部推理写入 summary。
  if (readMessageRole(message) === "user") {
    return {
      role: "user",
      content: readMessageContent(message),
    };
  }
  if (readMessageRole(message) === "assistant") {
    return {
      role: "assistant",
      content: readAssistantContent(message),
    };
  }
  if (readMessageRole(message) === "toolResult") {
    return {
      role: "toolResult",
      toolCallId: "toolCallId" in message ? message.toolCallId : undefined,
      toolName: "toolName" in message ? message.toolName : undefined,
      isError: "isError" in message ? message.isError : undefined,
      content: readMessageContent(message),
    };
  }
  return message;
}

function readAssistantSummary(
  message: AssistantMessage,
  outputFormat: LlmConversationSummarizerOutputFormat,
): string {
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    throw new Error(message.errorMessage ?? `Conversation summarizer failed with stopReason "${message.stopReason}".`);
  }
  const summary = message.content.flatMap((block) => {
    if (block.type !== "text") return [];
    return block.text;
  }).join("\n").trim();
  if (!summary) {
    throw new Error("Conversation summarizer returned an empty summary.");
  }
  if (outputFormat === "text") return summary;
  return renderStructuredConversationSummary(parseStructuredConversationSummary(summary));
}

function parseStructuredConversationSummary(value: string): StructuredConversationSummary {
  // 对模型输出做严格结构校验：summary 必须存在，列表字段如果出现就必须是字符串数组。
  // 这样非法 JSON 会在写入 compaction entry 前失败，而不是污染持久状态。
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonCodeFence(value));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Conversation summarizer returned invalid structured JSON: ${message}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Conversation summarizer structured JSON must be an object.");
  }
  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate.summary !== "string" || candidate.summary.trim() === "") {
    throw new Error("Conversation summarizer structured JSON requires a non-empty summary string.");
  }
  const facts = readOptionalStringList(candidate.facts, "facts");
  const decisions = readOptionalStringList(candidate.decisions, "decisions");
  const openQuestions = readOptionalStringList(candidate.openQuestions, "openQuestions");
  const currentTaskState = readOptionalStringList(candidate.currentTaskState, "currentTaskState");
  const risks = readOptionalStringList(candidate.risks, "risks");
  return {
    summary: candidate.summary.trim(),
    ...(facts === undefined ? {} : { facts }),
    ...(decisions === undefined ? {} : { decisions }),
    ...(openQuestions === undefined ? {} : { openQuestions }),
    ...(currentTaskState === undefined ? {} : { currentTaskState }),
    ...(risks === undefined ? {} : { risks }),
  };
}

function stripJsonCodeFence(value: string): string {
  const trimmed = value.trim();
  // 模型偶尔会违反“不要 markdown”的要求包一层 ```json fence，这里只做外层容错，
  // 内部 JSON 和字段类型仍然严格校验。
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return match?.[1]?.trim() ?? trimmed;
}

function readOptionalStringList(value: unknown, field: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`Conversation summarizer structured JSON field "${field}" must be an array.`);
  }
  return value.map((item, index) => {
    if (typeof item !== "string") {
      throw new Error(`Conversation summarizer structured JSON field "${field}" item ${index} must be a string.`);
    }
    return item.trim();
  }).filter(Boolean);
}

function renderStructuredConversationSummary(summary: StructuredConversationSummary): string {
  // projection 当前只消费 summary 文本，所以结构化字段会被渲染成稳定文本块。
  // 这让后续 LLM 能看到字段边界，同时避免现在升级 compaction entry schema。
  return [
    summary.summary,
    renderSummarySection("Facts", summary.facts),
    renderSummarySection("Decisions", summary.decisions),
    renderSummarySection("Open Questions", summary.openQuestions),
    renderSummarySection("Current Task State", summary.currentTaskState),
    renderSummarySection("Risks", summary.risks),
  ].filter(Boolean).join("\n\n");
}

function renderSummarySection(
  title: string,
  items: readonly string[] | undefined,
): string {
  if (!items || items.length === 0) return "";
  return [
    `${title}:`,
    ...items.map((item) => `- ${item}`),
  ].join("\n");
}

function readMessageContent(message: AgentMessage): unknown {
  if (!("content" in message)) return undefined;
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content;
  return content.map((block) => {
    if (!block || typeof block !== "object") return block;
    if (!("type" in block)) return block;
    if (block.type === "text") {
      return {
        type: "text",
        text: "text" in block ? block.text : "",
      };
    }
    if (block.type === "image") {
      return {
        type: "image",
        mimeType: "mimeType" in block ? block.mimeType : undefined,
        dataLength: "data" in block && typeof block.data === "string" ? block.data.length : undefined,
      };
    }
    return block;
  });
}

function readAssistantContent(message: AgentMessage): unknown {
  if (!("content" in message) || !Array.isArray(message.content)) return readMessageContent(message);
  return message.content.map((block) => {
    if (!block || typeof block !== "object" || !("type" in block)) return block;
    if (block.type === "toolCall") {
      return {
        type: "toolCall",
        id: "id" in block ? block.id : undefined,
        name: "name" in block ? block.name : undefined,
        arguments: "arguments" in block ? block.arguments : undefined,
      };
    }
    if (block.type === "thinking") {
      return {
        type: "thinking",
        redacted: "redacted" in block ? block.redacted : undefined,
      };
    }
    return readMessageContent({ ...message, content: [block] } as AgentMessage);
  });
}

function readMessageRole(message: AgentMessage): string {
  return typeof message.role === "string" ? message.role : "unknown";
}
