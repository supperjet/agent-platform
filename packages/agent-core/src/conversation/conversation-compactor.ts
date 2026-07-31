import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { ContextBudget } from "../context/context-budget.js";
import {
  isConversationCompactionEntry,
  isConversationMessageEntry,
  type ConversationCompactionEntry,
  type ConversationEntry,
  type ConversationEntryId,
  type ConversationMessageEntry,
} from "./conversation-entry.js";
import { buildActiveEntries } from "./conversation-projector.js";

export type ConversationCompactionReason = "manual" | "threshold" | "overflow";

export type ConversationCompactionPlan = {
  reason: ConversationCompactionReason;
  summary: string;
  sourceEntryIds: readonly ConversationEntryId[];
  preservedEntryIds: readonly ConversationEntryId[];
  instructions?: string;
  createdBy: string;
  selection?: ConversationCompactionSelectionResult;
};

export type ConversationCompactionDraft = {
  reason: ConversationCompactionReason;
  sourceMessages: readonly ConversationMessageEntry[];
  preservedMessages: readonly ConversationMessageEntry[];
  instructions?: string;
  createdBy: string;
  selection: ConversationCompactionSelectionResult;
};

export type ConversationSummarizerInput = {
  reason: ConversationCompactionReason;
  sourceMessages: readonly ConversationMessageEntry[];
  preservedMessages: readonly ConversationMessageEntry[];
  sourceEntryIds: readonly ConversationEntryId[];
  preservedEntryIds: readonly ConversationEntryId[];
  instructions?: string;
  selection: ConversationCompactionSelectionResult;
};

export type ConversationSummarizer = {
  summarize(input: ConversationSummarizerInput): string | Promise<string>;
};

/**
 * Source selection 的可组合阶段。
 *
 * `keep-last` 是窗口式切分：选择最近 N 条之前的所有候选。其他 stage 围绕
 * targetTokens 渐进选择，达到目标即可停止。
 */
export type ConversationCompactionSelectionStage =
  | {
    readonly mode: "keep-last";
    readonly protectLastMessages?: number;
  }
  | {
    readonly mode: "role-aware";
    readonly dropPriority?: Readonly<Record<string, number>>;
    readonly protectLastMessages?: number;
    readonly recencyHalfLife?: number;
  }
  | {
    readonly mode: "largest-first";
    readonly protectLastMessages?: number;
    readonly recencyHalfLife?: number;
  }
  | {
    readonly mode: "token-budget";
    readonly protectLastMessages?: number;
  };

export type ConversationCompactionSelectionOptions = {
  readonly contextBudget?: ContextBudget;
  readonly targetTokens?: number;
  readonly nextMessages?: readonly AgentMessage[];
  readonly systemPrompt?: string;
  readonly protectLastMessages?: number;
  readonly recencyHalfLife?: number;
  readonly stages?: readonly ConversationCompactionSelectionStage[];
};

/**
 * 被一起压缩或保留的最小消息组。
 *
 * 普通消息通常单独成组；assistant tool call 和匹配的 toolResult 会绑定成组，
 * 避免投影后留下“调用了工具但结果消失”的不连续上下文。
 */
export type ConversationCompactionMessageGroup = {
  readonly id: string;
  readonly entries: readonly ConversationMessageEntry[];
  readonly entryIds: readonly ConversationEntryId[];
  readonly roles: readonly string[];
  readonly startIndex: number;
  readonly endIndex: number;
  readonly distanceFromLatest: number;
  readonly protected: boolean;
  readonly estimatedTokens: number;
  readonly estimatedCharacters: number;
  readonly dependency: "none" | "tool-call";
  readonly toolCallIds: readonly string[];
};

export type ConversationCompactionSelectionGroupSummary = {
  readonly id: string;
  readonly entryIds: readonly ConversationEntryId[];
  readonly roles: readonly string[];
  readonly estimatedTokens: number;
  readonly estimatedCharacters: number;
  readonly dependency: "none" | "tool-call";
  readonly toolCallIds: readonly string[];
};

export type ConversationCompactionSelectionStageResult = {
  readonly stageIndex: number;
  readonly mode: ConversationCompactionSelectionStage["mode"];
  readonly targetTokens?: number;
  readonly tokensToRemove?: number;
  readonly candidateGroupIds: readonly string[];
  readonly selectedGroupIds: readonly string[];
  readonly selectedEntryIds: readonly ConversationEntryId[];
  readonly selectedGroups: readonly ConversationCompactionSelectionGroupSummary[];
  readonly selectedEstimatedTokens: number;
  readonly totalSelectedEstimatedTokens: number;
  readonly estimatedTokensAfterStage?: number;
  readonly reachedTarget?: boolean;
  readonly skipped?: boolean;
  readonly skipReason?: string;
};

export type ConversationCompactionSelectionResult = {
  readonly mode: "composite";
  readonly targetTokens?: number;
  readonly estimatedTokensBefore?: number;
  readonly estimatedTokensAfterTarget?: number;
  readonly selectedEntryIds: readonly ConversationEntryId[];
  readonly preservedEntryIds: readonly ConversationEntryId[];
  readonly selectedGroupIds: readonly string[];
  readonly selectedEstimatedTokens: number;
  readonly protectedEntryIds: readonly ConversationEntryId[];
  readonly stageResults: readonly ConversationCompactionSelectionStageResult[];
};

export type CreateConversationCompactionPlanOptions = {
  entries: readonly ConversationEntry[];
  leafId: ConversationEntryId | null;
  reason: ConversationCompactionReason;
  keepLastMessages?: number;
  instructions?: string;
  createdBy?: string;
  selection?: ConversationCompactionSelectionOptions;
};

export type CreateConversationCompactionPlanWithSummarizerOptions =
  CreateConversationCompactionPlanOptions & {
    summarizer?: ConversationSummarizer;
  };

const DEFAULT_KEEP_LAST_MESSAGES = 6;
// 数值越高，role-aware stage 越倾向把该 role 选入 sourceEntryIds。
// assistant 默认低于 user，是为了尽量保留历史回答和多轮对话连贯性。
const DEFAULT_ROLE_DROP_PRIORITY: Readonly<Record<string, number>> = {
  toolResult: 100,
  user: 70,
  assistant: 40,
};
const DEFAULT_RECENCY_HALF_LIFE = 4;

export function createConversationCompactionPlan(
  options: CreateConversationCompactionPlanOptions,
): ConversationCompactionPlan | undefined {
  const draft = createConversationCompactionDraft(options);
  if (!draft) return undefined;
  return createConversationCompactionPlanFromDraft(
    draft,
    summarizeConversationMessages(draft.sourceMessages, draft.instructions),
  );
}

export async function createConversationCompactionPlanWithSummarizer(
  options: CreateConversationCompactionPlanWithSummarizerOptions,
): Promise<ConversationCompactionPlan | undefined> {
  const draft = createConversationCompactionDraft(options);
  if (!draft) return undefined;
  // source selection 与摘要生成分离：draft 已经固定 source/preserved 边界，
  // summarizer 只能把这些 source messages 压缩成 summary，不能改变 graph 选择结果。
  const summary = options.summarizer
    ? await options.summarizer.summarize(createConversationSummarizerInput(draft))
    : summarizeConversationMessages(draft.sourceMessages, draft.instructions);
  return createConversationCompactionPlanFromDraft(draft, summary);
}

export function createConversationCompactionDraft(
  options: CreateConversationCompactionPlanOptions,
): ConversationCompactionDraft | undefined {
  const keepLastMessages = normalizeKeepLastMessages(options.keepLastMessages);
  const activeEntries = buildActiveEntries(options.entries, options.leafId);
  const alreadyCoveredEntryIds = new Set(
    activeEntries
      .filter(isConversationCompactionEntry)
      .flatMap((entry) => entry.payload.sourceEntryIds),
  );
  const activeMessages = activeEntries
    .filter(isConversationMessageEntry)
    .filter((entry) => !alreadyCoveredEntryIds.has(entry.id));
  const selection = options.selection
    ? selectConversationCompactionSources(activeMessages, options.selection)
    : selectConversationCompactionSources(activeMessages, {
      // Manual compact 的默认语义是“压缩旧历史，只保留最近 N 条”，所以这里显式
      // 使用 keep-last stage。自动策略的默认 stages 由 runtime policy 提供。
      protectLastMessages: keepLastMessages,
      stages: [{ mode: "keep-last" }],
    });
  const selectedEntryIds = new Set(selection.selectedEntryIds);
  const sourceMessages = activeMessages.filter((entry) => selectedEntryIds.has(entry.id));
  if (sourceMessages.length === 0) return undefined;

  const preservedMessages = activeMessages.filter((entry) => !selectedEntryIds.has(entry.id));
  return {
    reason: options.reason,
    sourceMessages,
    preservedMessages,
    ...(options.instructions ? { instructions: options.instructions } : {}),
    createdBy: options.createdBy ?? "runtime",
    selection,
  };
}

export function createConversationCompactionPlanFromDraft(
  draft: ConversationCompactionDraft,
  summary: string,
): ConversationCompactionPlan {
  return {
    reason: draft.reason,
    summary,
    sourceEntryIds: draft.sourceMessages.map((entry) => entry.id),
    preservedEntryIds: draft.preservedMessages.map((entry) => entry.id),
    ...(draft.instructions ? { instructions: draft.instructions } : {}),
    createdBy: draft.createdBy,
    selection: draft.selection,
  };
}

function createConversationSummarizerInput(
  draft: ConversationCompactionDraft,
): ConversationSummarizerInput {
  return {
    reason: draft.reason,
    sourceMessages: draft.sourceMessages,
    preservedMessages: draft.preservedMessages,
    sourceEntryIds: draft.sourceMessages.map((entry) => entry.id),
    preservedEntryIds: draft.preservedMessages.map((entry) => entry.id),
    ...(draft.instructions ? { instructions: draft.instructions } : {}),
    selection: draft.selection,
  };
}

export function createConversationCompactionEntry(input: {
  id: ConversationEntryId;
  parentId: ConversationEntryId | null;
  createdAt: string;
  plan: ConversationCompactionPlan;
}): ConversationCompactionEntry {
  return {
    kind: "compaction",
    id: input.id,
    parentId: input.parentId,
    createdAt: input.createdAt,
    payload: {
      summary: input.plan.summary,
      sourceEntryIds: input.plan.sourceEntryIds,
      reason: input.plan.reason,
      createdBy: input.plan.createdBy,
      ...(input.plan.preservedEntryIds.length > 0
        ? { preservedEntryIds: input.plan.preservedEntryIds }
        : {}),
      ...(input.plan.instructions ? { instructions: input.plan.instructions } : {}),
    },
  };
}

function normalizeKeepLastMessages(value: number | undefined) {
  if (value === undefined) return DEFAULT_KEEP_LAST_MESSAGES;
  if (!Number.isInteger(value) || value < 0) {
    throw new Error("Compaction keepLastMessages must be a non-negative integer.");
  }
  return value;
}

export function selectConversationCompactionSources(
  activeMessages: readonly ConversationMessageEntry[],
  options: ConversationCompactionSelectionOptions,
): ConversationCompactionSelectionResult {
  const contextBudget = options.contextBudget ?? new ContextBudget();
  const targetTokens = options.targetTokens === undefined
    ? undefined
    : normalizeTargetTokens(options.targetTokens);
  const allMessages = [
    ...activeMessages.map((entry) => entry.payload.message),
    ...(options.nextMessages ?? []),
  ];
  const estimate = contextBudget.estimate(allMessages, {
    ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
  });
  const tokensToRemove = targetTokens === undefined
    ? undefined
    : Math.max(0, estimate.estimatedTokens - targetTokens);
  const groups = buildCompactionMessageGroups(activeMessages, {
    ...options,
    contextBudget,
  });
  const selectedGroups = new Map<string, ConversationCompactionMessageGroup>();
  const stageResults: ConversationCompactionSelectionStageResult[] = [];

  // Stage pipeline: 每个 stage 从未选中、未受保护的 group 里继续选择。
  // 非 keep-last stage 达到 token 目标后停止；keep-last 是窗口式切分，会选中
  // 最近保护窗口之前的所有候选。
  for (const [stageIndex, stage] of (options.stages ?? []).entries()) {
    if (stage.mode !== "keep-last" && (tokensToRemove === undefined || tokensToRemove <= 0)) {
      stageResults.push(createSkippedStageResult({
        stage,
        stageIndex,
        estimate,
        targetTokens,
        tokensToRemove,
        selectedGroups,
        skipReason: tokensToRemove === undefined
          ? "targetTokens is not set"
          : "estimated tokens already fit targetTokens",
      }));
      continue;
    }
    const candidates = groups
      .filter((group) => !isGroupProtectedForStage(group, stage) && !selectedGroups.has(group.id))
      .sort((left, right) => compareGroupsForStage(left, right, stage, options));
    const stageSelectedGroups: ConversationCompactionMessageGroup[] = [];
    for (const group of candidates) {
      if (
        stage.mode !== "keep-last" &&
        tokensToRemove !== undefined &&
        sumSelectedTokens(selectedGroups) >= tokensToRemove
      ) {
        break;
      }
      selectedGroups.set(group.id, group);
      stageSelectedGroups.push(group);
    }
    stageResults.push(createStageResult({
      stage,
      stageIndex,
      estimate,
      targetTokens,
      tokensToRemove,
      candidates,
      stageSelectedGroups,
      selectedGroups,
    }));
    if (tokensToRemove !== undefined && sumSelectedTokens(selectedGroups) >= tokensToRemove) break;
  }

  const selectedEntryIds = [...selectedGroups.values()].flatMap((group) => group.entryIds);
  const selectedEntryIdSet = new Set(selectedEntryIds);
  return {
    mode: "composite",
    ...(targetTokens === undefined ? {} : { targetTokens }),
    estimatedTokensBefore: estimate.estimatedTokens,
    estimatedTokensAfterTarget: Math.max(0, estimate.estimatedTokens - sumSelectedTokens(selectedGroups)),
    selectedEntryIds,
    preservedEntryIds: activeMessages
      .filter((entry) => !selectedEntryIdSet.has(entry.id))
      .map((entry) => entry.id),
    selectedGroupIds: [...selectedGroups.keys()],
    selectedEstimatedTokens: sumSelectedTokens(selectedGroups),
    protectedEntryIds: groups
      .filter((group) => group.protected)
      .flatMap((group) => group.entryIds),
    stageResults,
  };
}

function createSkippedStageResult(input: {
  stage: ConversationCompactionSelectionStage;
  stageIndex: number;
  estimate: ReturnType<ContextBudget["estimate"]>;
  targetTokens: number | undefined;
  tokensToRemove: number | undefined;
  selectedGroups: ReadonlyMap<string, ConversationCompactionMessageGroup>;
  skipReason: string;
}): ConversationCompactionSelectionStageResult {
  const totalSelectedEstimatedTokens = sumSelectedTokens(input.selectedGroups);
  return {
    stageIndex: input.stageIndex,
    mode: input.stage.mode,
    ...(input.targetTokens === undefined ? {} : { targetTokens: input.targetTokens }),
    ...(input.tokensToRemove === undefined ? {} : { tokensToRemove: input.tokensToRemove }),
    candidateGroupIds: [],
    selectedGroupIds: [],
    selectedEntryIds: [],
    selectedGroups: [],
    selectedEstimatedTokens: 0,
    totalSelectedEstimatedTokens,
    estimatedTokensAfterStage: Math.max(0, input.estimate.estimatedTokens - totalSelectedEstimatedTokens),
    reachedTarget: input.tokensToRemove !== undefined && totalSelectedEstimatedTokens >= input.tokensToRemove,
    skipped: true,
    skipReason: input.skipReason,
  };
}

function createStageResult(input: {
  stage: ConversationCompactionSelectionStage;
  stageIndex: number;
  estimate: ReturnType<ContextBudget["estimate"]>;
  targetTokens: number | undefined;
  tokensToRemove: number | undefined;
  candidates: readonly ConversationCompactionMessageGroup[];
  stageSelectedGroups: readonly ConversationCompactionMessageGroup[];
  selectedGroups: ReadonlyMap<string, ConversationCompactionMessageGroup>;
}): ConversationCompactionSelectionStageResult {
  const selectedEstimatedTokens = input.stageSelectedGroups
    .reduce((total, group) => total + group.estimatedTokens, 0);
  const totalSelectedEstimatedTokens = sumSelectedTokens(input.selectedGroups);
  return {
    stageIndex: input.stageIndex,
    mode: input.stage.mode,
    ...(input.targetTokens === undefined ? {} : { targetTokens: input.targetTokens }),
    ...(input.tokensToRemove === undefined ? {} : { tokensToRemove: input.tokensToRemove }),
    candidateGroupIds: input.candidates.map((group) => group.id),
    selectedGroupIds: input.stageSelectedGroups.map((group) => group.id),
    selectedEntryIds: input.stageSelectedGroups.flatMap((group) => group.entryIds),
    selectedGroups: input.stageSelectedGroups.map(summarizeSelectionGroup),
    selectedEstimatedTokens,
    totalSelectedEstimatedTokens,
    estimatedTokensAfterStage: Math.max(0, input.estimate.estimatedTokens - totalSelectedEstimatedTokens),
    reachedTarget: input.tokensToRemove !== undefined && totalSelectedEstimatedTokens >= input.tokensToRemove,
  };
}

function summarizeSelectionGroup(
  group: ConversationCompactionMessageGroup,
): ConversationCompactionSelectionGroupSummary {
  return {
    id: group.id,
    entryIds: group.entryIds,
    roles: group.roles,
    estimatedTokens: group.estimatedTokens,
    estimatedCharacters: group.estimatedCharacters,
    dependency: group.dependency,
    toolCallIds: group.toolCallIds,
  };
}

function buildCompactionMessageGroups(
  activeMessages: readonly ConversationMessageEntry[],
  options: ConversationCompactionSelectionOptions & { contextBudget: ContextBudget },
): ConversationCompactionMessageGroup[] {
  const protectLastMessages = normalizeKeepLastMessages(options.protectLastMessages);
  const protectedStartIndex = Math.max(0, activeMessages.length - protectLastMessages);
  const groups: ConversationCompactionMessageGroup[] = [];
  const consumedIndexes = new Set<number>();

  for (let index = 0; index < activeMessages.length; index += 1) {
    if (consumedIndexes.has(index)) continue;
    const entry = activeMessages[index];
    if (!entry) continue;
    const toolCallIds = readAssistantToolCallIds(entry.payload.message);
    const groupedEntries = [entry];
    consumedIndexes.add(index);

    // Tool calls and results are dependency-bound for context validity.
    // If one assistant message requests multiple tools, collect the matching
    // results that appear later on the active path into the same group.
    if (toolCallIds.length > 0) {
      const pendingToolCallIds = new Set(toolCallIds);
      for (let nextIndex = index + 1; nextIndex < activeMessages.length; nextIndex += 1) {
        const nextEntry = activeMessages[nextIndex];
        if (!nextEntry || consumedIndexes.has(nextIndex)) continue;
        const toolCallId = readToolResultCallId(nextEntry.payload.message);
        if (!toolCallId || !pendingToolCallIds.has(toolCallId)) {
          if (pendingToolCallIds.size === 0) break;
          continue;
        }
        groupedEntries.push(nextEntry);
        consumedIndexes.add(nextIndex);
        pendingToolCallIds.delete(toolCallId);
        if (pendingToolCallIds.size === 0) break;
      }
    }

    groups.push(createMessageGroup({
      entries: groupedEntries,
      activeMessageCount: activeMessages.length,
      contextBudget: options.contextBudget,
      protectedStartIndex,
      groupIndex: groups.length,
      startIndex: index,
      endIndex: Math.max(...groupedEntries.map((groupedEntry) => activeMessages.indexOf(groupedEntry))),
    }));
  }

  return groups;
}

function createMessageGroup(input: {
  entries: readonly ConversationMessageEntry[];
  activeMessageCount: number;
  contextBudget: ContextBudget;
  protectedStartIndex: number;
  groupIndex: number;
  startIndex: number;
  endIndex: number;
}): ConversationCompactionMessageGroup {
  const messages = input.entries.map((entry) => entry.payload.message);
  const estimate = input.contextBudget.estimate(messages);
  const roles = [...new Set(messages.map(readMessageRole))];
  const toolCallIds = messages.flatMap((message) => [
    ...readAssistantToolCallIds(message),
    ...(readToolResultCallId(message) ? [readToolResultCallId(message) as string] : []),
  ]);
  return {
    id: `group:${input.groupIndex}`,
    entries: input.entries,
    entryIds: input.entries.map((entry) => entry.id),
    roles,
    startIndex: input.startIndex,
    endIndex: input.endIndex,
    distanceFromLatest: Math.max(0, input.activeMessageCount - 1 - input.endIndex),
    protected: input.endIndex >= input.protectedStartIndex,
    estimatedTokens: estimate.estimatedTokens,
    estimatedCharacters: estimate.estimatedCharacters,
    dependency: messages.some((message) => readAssistantToolCallIds(message).length > 0) ? "tool-call" : "none",
    toolCallIds: [...new Set(toolCallIds)],
  };
}

function compareGroupsForStage(
  left: ConversationCompactionMessageGroup,
  right: ConversationCompactionMessageGroup,
  stage: ConversationCompactionSelectionStage,
  options: ConversationCompactionSelectionOptions,
): number {
  if (stage.mode === "role-aware") {
    return compareByScore(
      scoreRoleAwareGroup(left, stage, options),
      scoreRoleAwareGroup(right, stage, options),
      left,
      right,
    );
  }
  if (stage.mode === "largest-first") {
    return compareByScore(
      scoreLargestFirstGroup(left, stage, options),
      scoreLargestFirstGroup(right, stage, options),
      left,
      right,
    );
  }
  // keep-last and token-budget both use chronological order. For keep-last this
  // preserves transcript order; for token-budget it is the final fallback after
  // more selective stages could not meet the target.
  return left.startIndex - right.startIndex;
}

function isGroupProtectedForStage(
  group: ConversationCompactionMessageGroup,
  stage: ConversationCompactionSelectionStage,
): boolean {
  if (group.protected) return true;
  if (stage.protectLastMessages === undefined) return false;
  const protectLastMessages = normalizeKeepLastMessages(stage.protectLastMessages);
  return group.distanceFromLatest < protectLastMessages;
}

function scoreRoleAwareGroup(
  group: ConversationCompactionMessageGroup,
  stage: Extract<ConversationCompactionSelectionStage, { mode: "role-aware" }>,
  options: ConversationCompactionSelectionOptions,
): number {
  const priorities = stage.dropPriority ?? DEFAULT_ROLE_DROP_PRIORITY;
  const roleScore = Math.max(...group.roles.map((role) => priorities[role] ?? 0));
  return roleScore + (group.estimatedTokens / 100) - recencyProtection(group, stage.recencyHalfLife ?? options.recencyHalfLife);
}

function scoreLargestFirstGroup(
  group: ConversationCompactionMessageGroup,
  stage: Extract<ConversationCompactionSelectionStage, { mode: "largest-first" }>,
  options: ConversationCompactionSelectionOptions,
): number {
  return group.estimatedTokens - (recencyProtection(group, stage.recencyHalfLife ?? options.recencyHalfLife) * group.estimatedTokens);
}

function compareByScore(
  leftScore: number,
  rightScore: number,
  left: ConversationCompactionMessageGroup,
  right: ConversationCompactionMessageGroup,
): number {
  if (rightScore !== leftScore) return rightScore - leftScore;
  return left.startIndex - right.startIndex;
}

function recencyProtection(
  group: ConversationCompactionMessageGroup,
  halfLife: number | undefined,
): number {
  // Exponential decay gives recent groups a soft shield without turning recency
  // into a blunt "drop everything before N" rule.
  const normalizedHalfLife = halfLife !== undefined && halfLife > 0
    ? halfLife
    : DEFAULT_RECENCY_HALF_LIFE;
  return Math.exp(-group.distanceFromLatest / normalizedHalfLife);
}

function sumSelectedTokens(
  groups: ReadonlyMap<string, ConversationCompactionMessageGroup>,
): number {
  return [...groups.values()].reduce((total, group) => total + group.estimatedTokens, 0);
}

function normalizeTargetTokens(value: number) {
  if (!Number.isFinite(value) || value < 1) {
    throw new Error("Compaction targetTokens must be a positive number.");
  }
  return Math.floor(value);
}

function readAssistantToolCallIds(message: AgentMessage): string[] {
  if (readMessageRole(message) !== "assistant") return [];
  if (!("content" in message) || !Array.isArray(message.content)) return [];
  return message.content.flatMap((block: unknown) => {
    if (!block || typeof block !== "object") return [];
    if (!("type" in block) || block.type !== "toolCall") return [];
    return "id" in block && typeof block.id === "string" ? [block.id] : [];
  });
}

function readToolResultCallId(message: AgentMessage): string | undefined {
  if (readMessageRole(message) !== "toolResult") return undefined;
  if (!("toolCallId" in message) || typeof message.toolCallId !== "string") return undefined;
  return message.toolCallId;
}

export function summarizeConversationMessages(
  entries: readonly ConversationMessageEntry[],
  instructions: string | undefined,
) {
  // deterministic summary 是默认实现，也是 LLM summarizer 显式 fallback 时的兜底。
  // 它刻意保持朴素、可预测，便于测试 projection / persistence 语义，不承担智能压缩效果。
  const lines = entries.map((entry, index) => {
    const message = entry.payload.message;
    const role = typeof message.role === "string" ? message.role : "unknown";
    const text = readMessageText(message).trim();
    return `${index + 1}. ${role}: ${text || "(empty)"}`;
  });
  return [
    `已压缩 ${entries.length} 条历史消息。`,
    ...(instructions ? [`压缩指令：${instructions}`] : []),
    ...lines,
  ].join("\n");
}

function readMessageText(message: AgentMessage): string {
  if (!("content" in message)) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((block: unknown) => {
    if (!block || typeof block !== "object" || !("type" in block) || block.type !== "text") return [];
    return "text" in block && typeof block.text === "string" ? [block.text] : [];
  }).join("\n");
}

function readMessageRole(message: AgentMessage): string {
  return typeof message.role === "string" ? message.role : "unknown";
}
