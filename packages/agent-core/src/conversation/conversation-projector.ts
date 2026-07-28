import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
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
 * - LLM messages 只来自 active path 上的 `kind: "message"` entries。
 * - 投影时 clone message，避免模型调用或上层代码意外修改持久化快照。
 */
export class ConversationProjector {
  projectMessages(input: ConversationProjectionInput): AgentMessage[] {
    return buildActiveEntries(input.entries, input.leafId ?? null).flatMap((entry) => {
      const message = readConversationEntryMessage(entry);
      if (message) return [structuredClone(message)];
      return [];
    });
  }
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
