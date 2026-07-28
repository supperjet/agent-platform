import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * conversation entry 在一个会话状态图中的唯一标识。
 *
 * 当前 StateExporter 使用 `${sessionId}:entry:${n}` 生成新 id；恢复外部传入
 * state 时并不要求固定前缀，只要求同一 payload 内唯一，并且 parentId/leafId
 * 都能引用到已有 entry。
 */
export type ConversationEntryId = string;

/**
 * 普通对话消息 entry。
 *
 * 这是唯一会被 `ConversationProjector` 默认投影成 LLM prompt messages 的 entry。
 * 其他 entry 可以保留在 state graph 里，用于恢复、审计或后续能力，但不会自动
 * 变成模型上下文。
 */
export type ConversationMessageEntry = {
  /** entry 类型。v2 state 统一使用 kind/createdAt/payload 结构。 */
  kind: "message";
  /** 当前 entry id，在同一个 AgentConversationState.payload.entries 内必须唯一。 */
  id: ConversationEntryId;
  /** 指向上一条 active path entry；null 表示这条 entry 是根节点。 */
  parentId: ConversationEntryId | null;
  /** entry 创建时间，使用可序列化的 ISO 字符串。 */
  createdAt: string;
  /** message payload 单独包一层，方便 v2 entry 结构保持统一。 */
  payload: {
    /** 底层 AgentLoop/LLM 使用的真实消息对象。 */
    message: AgentMessage;
  };
};

/**
 * 压缩摘要 entry。
 *
 * 它表示某段旧历史已经被压缩成 summary。当前 D.1 只定义 schema 和保留语义，
 * 不把 summary 默认投影进 LLM messages；阶段 E 的 compaction 会决定如何消费。
 */
export type ConversationCompactionEntry = {
  kind: "compaction";
  id: ConversationEntryId;
  parentId: ConversationEntryId | null;
  createdAt: string;
  payload: {
    /** 对被压缩历史的自然语言摘要。 */
    summary: string;
    /** 可选：这条摘要覆盖或来源于哪些 entry，用于诊断和审计。 */
    sourceEntryIds?: readonly ConversationEntryId[];
  };
};

/**
 * 扩展或 workflow 的结构化持久状态 entry。
 *
 * 例如 planner、skill selector、某个资源同步器可以用 namespace 隔离自己的
 * checkpoint。它不应该伪装成 message，因为 message 是 LLM 对话事实。
 */
export type ConversationCustomStateEntry = {
  kind: "custom_state";
  id: ConversationEntryId;
  parentId: ConversationEntryId | null;
  createdAt: string;
  payload: {
    /** 状态所属命名空间，避免不同扩展互相覆盖。 */
    namespace: string;
    /** 由 namespace 自己解释的可序列化状态。 */
    state: unknown;
  };
};

/**
 * 会话环境信息 entry。
 *
 * 用于记录恢复时需要参考的环境事实，例如 cwd、agent definition、资源版本等。
 * D.1 只保留 payload，具体兼容性策略后续由 runtime/session 层定义。
 */
export type ConversationSessionInfoEntry = {
  kind: "session_info";
  id: ConversationEntryId;
  parentId: ConversationEntryId | null;
  createdAt: string;
  /** 保持宽松结构，避免 session_info 每新增字段都要改核心 union。 */
  payload: Record<string, unknown>;
};

/**
 * 面向未来扩展的未知 entry。
 *
 * 恢复层会校验它拥有 v2 entry 基础字段，并把它保留在 state graph 中。
 * Projector 不认识它，因此不会投影成模型消息。这让 schema 可以向前兼容新 entry。
 */
export type ConversationUnknownEntry = {
  kind: string;
  id: ConversationEntryId;
  parentId: ConversationEntryId | null;
  createdAt: string;
  payload: unknown;
};

export type ConversationEntry =
  | ConversationMessageEntry
  | ConversationCompactionEntry
  | ConversationCustomStateEntry
  | ConversationSessionInfoEntry
  | ConversationUnknownEntry;

/**
 * ConversationStore.restore 后给 runtime 使用的规范化快照。
 *
 * - entries/leafId 保留完整 graph，供 StateExporter 后续继续追加。
 * - messages 是从 active leaf path 投影出来的 LLM 可见消息序列。
 * - compatibility 是恢复时的运行环境信息，不直接持久化进 v2 payload。
 */
export type ConversationSnapshot = {
  entries: readonly ConversationEntry[];
  leafId: ConversationEntryId | null;
  messages: readonly AgentMessage[];
  compatibility: {
    modelId: string;
    definitionId?: string;
  };
};

/** AgentConversationState.payload 的 v2 结构。 */
export type ConversationEntriesPayload = {
  /** 完整 entry graph，包含 active path 和可能的旁支/扩展 entry。 */
  entries: readonly ConversationEntry[];
  /** 当前 active branch 的叶子 entry；null 表示空会话。 */
  leafId: ConversationEntryId | null;
};

/** 类型守卫：判断 entry 是否为 LLM 对话消息。 */
export function isConversationMessageEntry(
  entry: ConversationEntry
): entry is ConversationMessageEntry {
  return entry.kind === "message";
}

/**
 * 从 entry 中读取 AgentMessage。
 *
 * 注意：这里只对 `kind: "message"` 返回消息。未知 entry 即使 payload 里碰巧有
 * message 字段，也不会被当作对话消息，避免扩展 entry 意外污染 prompt。
 */
export function readConversationEntryMessage(entry: ConversationEntry): AgentMessage | undefined {
  if (entry.kind === "message") {
    const payload = entry.payload as { message?: unknown };
    return payload.message as AgentMessage | undefined;
  }
  return undefined;
}
