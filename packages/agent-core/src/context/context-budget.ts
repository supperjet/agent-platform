import type { AgentMessage } from "@earendil-works/pi-agent-core";

export type ContextBudgetEstimate = {
  /** 本次上下文中的消息数量。 */
  messageCount: number;
  /** 使用字符数做第一版粗估，后续可替换为模型 token 估算。 */
  estimatedCharacters: number;
};

/**
 * ContextBudget 负责估算每轮上下文成本。
 *
 * 第一版只做只读估算，不裁剪、不改写 messages。这样 ContextAssembler 可以先把
 * budget 信息放进 metadata，后续再逐步接入资源选择、memory 裁剪和会话压缩策略。
 */
export class ContextBudget {
  estimate(messages: readonly AgentMessage[]): ContextBudgetEstimate {
    return {
      messageCount: messages.length,
      estimatedCharacters: messages.reduce((total, message) => total + estimateMessageCharacters(message), 0),
    };
  }
}

function estimateMessageCharacters(message: AgentMessage): number {
  if (!("content" in message)) return 0;
  if (typeof message.content === "string") return message.content.length;
  if (!Array.isArray(message.content)) return 0;

  return message.content.reduce((total, block) => {
    if (!block || typeof block !== "object") return total;
    if ("text" in block && typeof block.text === "string") return total + block.text.length;
    return total;
  }, 0);
}
