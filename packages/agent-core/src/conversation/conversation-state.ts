import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentConversationState } from "../contracts.js";
import {
  type ConversationEntriesPayload,
  type ConversationEntry,
  type ConversationSnapshot
} from "./conversation-entry.js";
import { ConversationProjector } from "./conversation-projector.js";

/**
 * 导出 v2 AgentConversationState。
 *
 * 这里是 conversation 模块对外生成持久化 state 的唯一入口：
 * - schemaVersion 固定为 2。
 * - entries/leafId 使用 structuredClone，避免调用方继续持有内部可变引用。
 * - 不再支持老的 `{ messages }` payload；message 必须作为 entry graph 的一部分。
 */
export function exportConversationEntriesState(
  modelId: string,
  entries: readonly ConversationEntry[],
  leafId: string | null
): AgentConversationState {
  return {
    schemaVersion: 2,
    modelId,
    payload: {
      entries: structuredClone(entries),
      leafId
    }
  };
}

/**
 * 从持久化 state 恢复为 runtime 可用的 conversation snapshot。
 *
 * 这个函数做三件事：
 * 1. 没有 state 时创建空会话。
 * 2. 校验 schemaVersion/modelId/payload/entry graph 合法性。
 * 3. 通过 ConversationProjector 只把 active leaf path 上的 message entries
 *    投影成 LLM messages。
 */
export function restoreConversationSnapshot(
  state: AgentConversationState | undefined,
  modelId: string,
  definitionId?: string
): ConversationSnapshot {
  if (!state) {
    return {
      entries: [],
      leafId: null,
      messages: [],
      compatibility: createCompatibility(modelId, definitionId)
    };
  }
  assertSupportedState(state, modelId);

  if (isEntriesPayload(state.payload)) {
    const entries = structuredClone(state.payload.entries) as ConversationEntry[];
    return createSnapshot(entries, state.payload.leafId, modelId, definitionId);
  }

  throw new Error("Agent conversation state payload is invalid.");
}

/**
 * 兼容一些只需要 messages 的内部调用方。
 *
 * 注意它不是 legacy `{ messages }` state 支持；它仍然走 v2 entry graph restore，
 * 只是把恢复后的 active transcript 拿出来。
 */
export function restoreConversationMessages(
  state: AgentConversationState | undefined,
  modelId: string
): AgentMessage[] {
  return [...restoreConversationSnapshot(state, modelId).messages];
}

/** 校验 state 的版本和模型兼容性。 */
function assertSupportedState(state: AgentConversationState, modelId: string) {
  if (state.schemaVersion !== 2) {
    throw new Error(`Unsupported Agent conversation state version "${state.schemaVersion}".`);
  }
  if (state.modelId !== modelId) {
    throw new Error(`Agent conversation model "${state.modelId}" does not match runtime model "${modelId}".`);
  }
}

/**
 * 创建规范化 snapshot。
 *
 * entries 会被 clone 后保存在 snapshot 里；messages 则由 projector 从 active path
 * 重新计算，避免信任外部 payload 里可能混入的派生字段。
 */
function createSnapshot(
  entries: readonly ConversationEntry[],
  leafId: string | null,
  modelId: string,
  definitionId?: string
): ConversationSnapshot {
  const projector = new ConversationProjector();
  return {
    entries: structuredClone(entries),
    leafId,
    messages: projector.projectMessages({ entries, leafId }),
    compatibility: createCompatibility(modelId, definitionId)
  };
}

/** 生成恢复兼容性信息。definitionId 来自当前 runtime assembly，不是持久化字段。 */
function createCompatibility(modelId: string, definitionId?: string): ConversationSnapshot["compatibility"] {
  return {
    modelId,
    ...(definitionId ? { definitionId } : {})
  };
}

/**
 * 校验 payload 是否为 v2 entries payload。
 *
 * 返回 false 只表示“不是 entries payload”，让上层抛统一的 payload invalid；
 * 一旦发现 payload 看起来是 entries 但字段损坏，就直接抛出更具体的错误。
 */
function isEntriesPayload(payload: unknown): payload is ConversationEntriesPayload {
  if (!payload || typeof payload !== "object" || !("entries" in payload)) return false;
  const entries = payload.entries;
  if (!Array.isArray(entries)) {
    throw new Error("Agent conversation state entries are invalid.");
  }
  if (!("leafId" in payload) || (payload.leafId !== null && typeof payload.leafId !== "string")) {
    throw new Error("Agent conversation state leafId is invalid.");
  }
  for (const entry of entries) assertConversationEntry(entry);
  assertEntryGraph(entries, payload.leafId);
  return true;
}

/**
 * 校验单个 conversation entry 的基础结构。
 *
 * D.1 允许未知 kind 的 entry 被保留，因此这里不会因为 kind 不在当前 union 的
 * 已知集合中而拒绝。只有 `kind: "message"` 需要额外校验 payload.message，
 * 因为 message entry 会进入 LLM prompt projection。
 */
function assertConversationEntry(entry: unknown): asserts entry is ConversationEntry {
  if (!entry || typeof entry !== "object") {
    throw new Error("Agent conversation state entries are invalid.");
  }
  if (!("id" in entry) || typeof entry.id !== "string" || entry.id.trim().length === 0) {
    throw new Error("Agent conversation state entry id is invalid.");
  }
  if (!("parentId" in entry) || (entry.parentId !== null && typeof entry.parentId !== "string")) {
    throw new Error("Agent conversation state entry parentId is invalid.");
  }
  if (!("kind" in entry) || typeof entry.kind !== "string" || entry.kind.trim().length === 0) {
    throw new Error("Agent conversation state entry kind is invalid.");
  }
  if (!("createdAt" in entry) || typeof entry.createdAt !== "string" || entry.createdAt.trim().length === 0) {
    throw new Error("Agent conversation state entry createdAt is invalid.");
  }
  if (!("payload" in entry)) {
    throw new Error("Agent conversation state entry payload is invalid.");
  }
  if (entry.kind === "message") {
    const payload = entry.payload;
    if (!payload || typeof payload !== "object" || !("message" in payload)) {
      throw new Error("Agent conversation state entry message payload is invalid.");
    }
    const message = payload.message;
    if (!message || typeof message !== "object") {
      throw new Error("Agent conversation state entry message is invalid.");
    }
  }
}

/**
 * 校验 entry graph 的引用完整性。
 *
 * 这里不强制 graph 必须是一条链，也不阻止分支；只保证：
 * - id 在 payload 内唯一。
 * - leafId 如果存在，必须指向某个 entry。
 * - parentId 如果存在，也必须指向某个 entry。
 */
function assertEntryGraph(entries: readonly ConversationEntry[], leafId: string | null) {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id)) {
      throw new Error(`Agent conversation state contains duplicate entry id: ${entry.id}`);
    }
    ids.add(entry.id);
  }
  if (leafId !== null && !ids.has(leafId)) {
    throw new Error(`Agent conversation state leafId does not reference an entry: ${leafId}`);
  }
  for (const entry of entries) {
    if (entry.parentId !== null && !ids.has(entry.parentId)) {
      throw new Error(`Agent conversation state entry parentId does not reference an entry: ${entry.parentId}`);
    }
  }
}
