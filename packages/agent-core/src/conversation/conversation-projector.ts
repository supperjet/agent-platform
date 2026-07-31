import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  isConversationCompactionEntry,
  readConversationEntryMessage,
  type ConversationEntry,
  type ConversationEntryId
} from "./conversation-entry.js";

export type ConversationProjectionInput = {
  /** 完整 conversation entry graph。 */
  entries: readonly ConversationEntry[];
  /** 当前 active branch 的叶子 entry；未传或 null 时按 entries 原顺序处理。 */
  leafId?: ConversationEntryId | null;
};

/**
 * ConversationProjector 负责把持久化 graph 投影成 LLM 可见消息。
 *
 * 它是“state graph”和“模型上下文”之间的边界：
 * - graph 可以保存 compaction/custom_state/session_info/unknown entries。
 * - LLM messages 来自 active path 上的 `kind: "message"` entries，以及
 *   `kind: "compaction"` 产生的 summary context message。
 * - compaction 不删除 source message entries；投影时用 summary 替代它们。
 * - 投影时 clone message，避免模型调用或上层代码意外修改持久化快照。
 */
export class ConversationProjector {
  projectMessages(input: ConversationProjectionInput): AgentMessage[] {
    const activeEntries = buildActiveEntries(input.entries, input.leafId ?? null);
    const compactionProjection = buildCompactionProjection(activeEntries);
    const messages: AgentMessage[] = [];

    activeEntries.forEach((entry, index) => {
      for (const summaryMessage of compactionProjection.summaryMessagesByIndex.get(index) ?? []) {
        messages.push(summaryMessage);
      }

      const message = readConversationEntryMessage(entry);
      if (message && !compactionProjection.coveredMessageEntryIds.has(entry.id)) {
        messages.push(structuredClone(message));
      }
    });

    return messages;
  }
}

type CompactionProjection = {
  summaryMessagesByIndex: Map<number, AgentMessage[]>;
  coveredMessageEntryIds: Set<ConversationEntryId>;
};

function buildCompactionProjection(activeEntries: readonly ConversationEntry[]): CompactionProjection {
  const entryIndexById = new Map(activeEntries.map((entry, index) => [entry.id, index]));
  const summaryMessagesByIndex = new Map<number, AgentMessage[]>();
  const coveredMessageEntryIds = new Set<ConversationEntryId>();

  activeEntries.forEach((entry, compactionIndex) => {
    if (!isConversationCompactionEntry(entry)) return;

    const sourceMessageIndices = entry.payload.sourceEntryIds.flatMap((sourceEntryId) => {
      const sourceIndex = entryIndexById.get(sourceEntryId);
      if (sourceIndex === undefined) return [];
      const sourceEntry = activeEntries[sourceIndex];
      if (!sourceEntry || !readConversationEntryMessage(sourceEntry)) return [];
      return [sourceIndex];
    });

    for (const sourceEntryId of entry.payload.sourceEntryIds) {
      coveredMessageEntryIds.add(sourceEntryId);
    }

    const insertionIndex = sourceMessageIndices.length > 0
      ? Math.min(...sourceMessageIndices)
      : compactionIndex;
    const existing = summaryMessagesByIndex.get(insertionIndex) ?? [];
    existing.push(createCompactionSummaryMessage(entry));
    summaryMessagesByIndex.set(insertionIndex, existing);
  });

  return { summaryMessagesByIndex, coveredMessageEntryIds };
}

function createCompactionSummaryMessage(entry: ConversationEntry): AgentMessage {
  if (!isConversationCompactionEntry(entry)) {
    throw new Error("Conversation compaction summary message requires a compaction entry.");
  }
  const timestamp = Date.parse(entry.createdAt);
  return {
    role: "user",
    content: [{ type: "text", text: `此前对话摘要：\n${entry.payload.summary}` }],
    ...(Number.isFinite(timestamp) ? { timestamp } : {})
  } as unknown as AgentMessage;
}

/**
 * 根据 leafId 计算 active path。
 *
 * entry graph 允许存在分支：同一个 parent 下可以有多个 child。恢复给模型时，
 * 只能选择从 leafId 回溯到 root 的那条路径。比如：
 *
 * ```text
 * root
 *  ├─ main
 *  └─ branch <- leafId
 * ```
 *
 * active entries 就是 `[root, branch]`。
 */
export function buildActiveEntries(
  entries: readonly ConversationEntry[],
  leafId: ConversationEntryId | null
): ConversationEntry[] {
  // 空 graph 没有 active path。
  if (entries.length === 0) return [];
  // 没有 leafId 时，通常表示调用方只是想按原顺序投影一个无分支列表。
  if (!leafId) return [...entries];

  // 用 Map 做 id -> entry 索引，方便从 leaf 一路沿 parentId 回溯。
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const path: ConversationEntry[] = [];
  let current: ConversationEntry | undefined = byId.get(leafId);

  // 从 leaf 往 root 走，先收集反向路径。
  while (current) {
    path.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }

  // leafId 已在 restore validation 中校验过；这里保留空路径保护，避免直接调用
  // buildActiveEntries 时传入了一个不存在的 leafId。
  if (path.length === 0) return [];
  // 回溯得到的是 leaf -> root，所以要反转成 prompt 的自然顺序 root -> leaf。
  return path.reverse();
}
