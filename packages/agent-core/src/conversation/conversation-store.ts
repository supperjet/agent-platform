import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentConversationState } from "../contracts.js";
import type { ConversationSnapshot } from "./conversation-entry.js";
import { restoreConversationSnapshot } from "./conversation-state.js";

/**
 * 恢复 conversation 所需的宿主输入。
 *
 * state 来自外部持久化层；modelId/definitionId 来自当前 runtime assembly。
 * conversation 模块会用 modelId 做强校验，避免把旧模型的上下文恢复到新模型运行态。
 */
export type ConversationRestoreInput = {
  /** 可选持久化 state；未提供时恢复为空会话。 */
  state?: AgentConversationState;
  /** 当前 runtime 使用的模型 id，必须与 state.modelId 一致。 */
  modelId: string;
  /** 当前 AgentDefinition id，只作为恢复兼容性 metadata 暴露给上层。 */
  definitionId?: string;
};

/**
 * runtime 内部使用的 conversation state。
 *
 * ConversationSnapshot.messages 是 readonly；RuntimeAssembler/AgentLoop 需要一个
 * 普通数组交给底层 loop，因此这里把 messages 扩成可复制的数组类型。
 */
export type ConversationRuntimeState = ConversationSnapshot & {
  messages: AgentMessage[];
};

/**
 * ConversationStore 是 runtime assembly 面向 conversation 模块的窄接口。
 *
 * 它目前不直接访问数据库或文件系统；真正的 durable persistence 由宿主负责。
 * 这里的职责只是把 `AgentConversationState` 校验、规范化并恢复成 runtime 可用
 * 的 entries/leafId/messages/compatibility。
 */
export class ConversationStore {
  restore(input: ConversationRestoreInput): ConversationRuntimeState {
    const snapshot = restoreConversationSnapshot(input.state, input.modelId, input.definitionId);
    return {
      ...snapshot,
      // 返回一个新的 messages 数组，避免调用方修改 snapshot.messages 的 readonly
      // 视图时影响 conversation 模块内部的投影结果。
      messages: [...snapshot.messages]
    };
  }
}
