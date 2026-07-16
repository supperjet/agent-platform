import type { Message } from "@earendil-works/pi-ai";

/**
 * 把 runtime command 中的纯文本转换成 provider-neutral user message。
 *
 * AgentLoop 使用 pi-ai 的 Message 结构，因此 prompt/steer/follow-up 等
 * 文本命令进入底层 agent 前都先经过这里。
 */
export function createUserMessage(text: string): Message {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now()
  };
}
