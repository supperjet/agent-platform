import { type AgentConversationState } from "../contracts.js";
import {
  createConversationCompactionEntry,
  type ConversationCompactionPlan,
} from "../conversation/conversation-compactor.js";
import type {
  ConversationEntry,
  ConversationEntryId,
} from "../conversation/conversation-entry.js";
import { ConversationProjector } from "../conversation/conversation-projector.js";
import { exportConversationEntriesState } from "../conversation/conversation-state.js";
import type { ConversationRuntimeState } from "../conversation/conversation-store.js";
import type { AgentLoopSnapshot } from "./agent-loop.js";

/**
 * StateExporter 的会话级输入。
 */
export type StateExporterOptions = {
  /** 当前 session ID，用于生成新的 conversation entry id。 */
  sessionId: string;
  /** RuntimeAssembler 恢复出来的初始会话图状态。 */
  conversation: ConversationRuntimeState;
};

/**
 * 状态导出器。
 *
 * 底层 AgentLoop 只维护线性的 messages；agent-core 的可恢复状态使用
 * conversation entry graph。StateExporter 负责把两者同步：
 * - 初始化时接收已恢复的 entry graph。
 * - 每个回合结束后读取 loop snapshot，把新增 message 追加成 entry。
 * - exportState 时输出带 schemaVersion 的 AgentConversationState。
 */
export class StateExporter {
  private readonly sessionId: string;
  private readonly projector = new ConversationProjector();
  private entries: ConversationEntry[];
  private leafId: ConversationEntryId | null;
  private entrySequence: number;

  constructor(options: StateExporterOptions) {
    this.sessionId = options.sessionId;
    this.entries = [...options.conversation.entries];
    this.leafId = options.conversation.leafId;
    this.entrySequence = readEntrySequence(this.entries);
  }

  /**
   * 将底层 loop 的线性消息快照同步到 entry graph。
   *
   * 这里假设 loop 只会在当前 active path 末尾追加消息；如果底层消息数量
   * 比 active entries 更少，说明历史被意外截断，直接报错保护状态一致性。
   */
  syncFromSnapshot(snapshot: AgentLoopSnapshot) {
    const projectedMessages = this.projector.projectMessages({
      entries: this.entries,
      leafId: this.leafId,
    });
    if (snapshot.messages.length < projectedMessages.length) {
      throw new Error(
        "Agent conversation graph cannot sync after message history shrank.",
      );
    }

    const newMessages = snapshot.messages.slice(projectedMessages.length);
    for (const message of newMessages) {
      // 每条新增消息都挂到当前 leaf 后面，形成一条新的 active path。
      const entry: ConversationEntry = {
        kind: "message",
        id: this.nextEntryId(),
        parentId: this.leafId,
        createdAt: new Date().toISOString(),
        payload: {
          message: structuredClone(message),
        },
      };
      this.entries.push(entry);
      this.leafId = entry.id;
    }
  }

  /** 同步最新 snapshot 后，导出可持久化/可恢复的会话状态。 */
  exportState(snapshot: AgentLoopSnapshot): AgentConversationState {
    this.syncFromSnapshot(snapshot);
    return exportConversationEntriesState(
      snapshot.modelId,
      this.entries,
      this.leafId,
    );
  }

  /** 追加一条 compaction entry，并让当前 active leaf 指向它。 */
  appendCompaction(plan: ConversationCompactionPlan): ConversationEntry {
    const entry = createConversationCompactionEntry({
      id: this.nextEntryId(),
      parentId: this.leafId,
      createdAt: new Date().toISOString(),
      plan,
    });
    this.entries.push(entry);
    this.leafId = entry.id;
    return structuredClone(entry);
  }

  /** 按当前 entry graph 投影 LLM 可见 messages。 */
  projectMessages() {
    return this.projector.projectMessages({
      entries: this.entries,
      leafId: this.leafId,
    });
  }

  /** 生成当前 session 内单调递增的 conversation entry id。 */
  private nextEntryId() {
    this.entrySequence += 1;
    return `${this.sessionId}:entry:${this.entrySequence}`;
  }
}

/**
 * 从已恢复 entries 中读取当前最大序号。
 *
 * 这样恢复会话后继续追加 entry 时，不会和已有 entry id 冲突。
 */
function readEntrySequence(entries: readonly ConversationEntry[]) {
  return entries.reduce((max, entry) => {
    const prefix = `${entry.id.slice(0, entry.id.lastIndexOf(":") + 1)}`;
    if (!prefix.endsWith(":entry:")) return max;
    const value = Number(entry.id.slice(prefix.length));
    return Number.isInteger(value) && value > max ? value : max;
  }, 0);
}
