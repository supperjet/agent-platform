import type { BrowserAgentEvent } from "./browser-events.js";

export type PublicCommandType = "prompt" | "steer" | "follow-up" | "abort";

export type PublicCommand = {
  commandId: string; // 命令ID
  type: PublicCommandType;
  text?: string;
};

export type PublicCommandReceipt = {
  accepted: true; // 是否接受
  sessionId: string; // 会话ID
  commandId: string; // 命令ID
  type: PublicCommandType; // 命令类型
};

export type PublicSession = {
  sessionId: string; // 会话ID
  status: "idle" | "running" | "failed" | "commit_failed" | "closed"; // 状态
  createdAt: string; // 创建时间
  lastActiveAt: string; // 最后活跃时间
  messageCount: number; // 消息数量
  modelId: string; // 模型ID
};

export type PublicAgentEvent = {
  eventId: string; // 事件ID
  sequence: number; // 序列号
  sessionId: string; // 会话ID
  commandId: string; // 命令ID
  type: BrowserAgentEvent["type"]; // 事件类型
  occurredAt: string; // 发生时间
  payload: Record<string, unknown>; // 负载
};

export type PublicEventHistory = {
  sessionId: string;
  events: PublicAgentEvent[];
};
