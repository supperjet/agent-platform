import type {
  AgentExecutionOutcome,
  AgentRuntimeCommand,
} from "../contracts.js";

/** 一次 runtime command / prompt turn 的可持久化执行状态。 */
export type AgentRunStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "aborted"
  | "commit_failed";

/**
 * 创建 run 记录所需的最小输入。
 *
 * runId 由宿主生成，commandId 对齐 server command / playground 输入记录。
 * core 不规定 id 格式，避免绑定数据库、自增序列或本地文件路径策略。
 */
export type AgentRunStartInput = {
  runId: string;
  sessionId: string;
  commandId: string;
  commandType: AgentRuntimeCommand["type"];
  startedAt: string;
};

/** run 进入终态时写入的 outcome 信息。 */
export type AgentRunFinishInput = {
  status: Exclude<AgentRunStatus, "running">;
  outcome: AgentExecutionOutcome;
  endedAt: string;
};

/**
 * RunStore 保存的是“这次执行发生了什么”，不是恢复 LLM 上下文的主事实。
 *
 * conversation 恢复仍然以 AgentConversationState 为准；RunRecord 主要用于 UI、
 * 审计、失败定位和 commit_failed repair/replay 策略。
 */
export type AgentRunRecord = AgentRunStartInput & {
  status: AgentRunStatus;
  endedAt?: string;
  outcome?: AgentExecutionOutcome;
};

/** run lifecycle 的持久化接口；具体介质由 server/playground/CLI 宿主实现。 */
export abstract class RunStore {
  abstract start(input: AgentRunStartInput): Promise<AgentRunRecord>;
  abstract finish(runId: string, input: AgentRunFinishInput): Promise<AgentRunRecord>;
  abstract get(runId: string): Promise<AgentRunRecord | undefined>;
  abstract listBySession(sessionId: string): Promise<AgentRunRecord[]>;
}

/** 测试和本地组合层可复用的最小内存实现。 */
export class InMemoryRunStore extends RunStore {
  private readonly runs = new Map<string, AgentRunRecord>();

  async start(input: AgentRunStartInput): Promise<AgentRunRecord> {
    if (this.runs.has(input.runId)) {
      throw new Error(`Run "${input.runId}" already exists.`);
    }
    const record: AgentRunRecord = {
      ...input,
      status: "running"
    };
    this.runs.set(input.runId, record);
    return { ...record };
  }

  async finish(runId: string, input: AgentRunFinishInput): Promise<AgentRunRecord> {
    const existing = this.runs.get(runId);
    if (!existing) throw new Error(`Run "${runId}" was not found.`);
    if (existing.status !== "running") {
      throw new Error(`Run "${runId}" is already ${existing.status}.`);
    }
    if (input.status !== input.outcome.status) {
      throw new Error(`Run "${runId}" finish status must match outcome status.`);
    }
    const record: AgentRunRecord = {
      ...existing,
      status: input.status,
      endedAt: input.endedAt,
      outcome: input.outcome
    };
    this.runs.set(runId, record);
    return { ...record };
  }

  async get(runId: string): Promise<AgentRunRecord | undefined> {
    const record = this.runs.get(runId);
    return record ? { ...record } : undefined;
  }

  async listBySession(sessionId: string): Promise<AgentRunRecord[]> {
    return [...this.runs.values()]
      .filter((record) => record.sessionId === sessionId)
      .sort(compareRunRecords)
      .map((record) => ({ ...record }));
  }
}

function compareRunRecords(left: AgentRunRecord, right: AgentRunRecord): number {
  if (left.startedAt !== right.startedAt) return left.startedAt.localeCompare(right.startedAt);
  return left.runId.localeCompare(right.runId);
}
