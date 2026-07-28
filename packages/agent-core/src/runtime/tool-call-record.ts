import type { AgentRuntimeEvent } from "../contracts.js";
import type { AgentStoredEvent } from "./event-store.js";

export type AgentToolCallRecoveryStatus =
  | "succeeded"
  | "failed"
  | "aborted";

export type AgentToolCallSummary = {
  value: string;
  truncated: boolean;
};

/**
 * 可持久化的工具调用事实记录。
 *
 * 这类记录用于 UI、审计、诊断和恢复时判断“上次运行里有哪些工具调用没有
 * 正常收口”。它不是 conversation state，也不代表恢复后要继续某个进程内工具。
 */
export type AgentToolCallRecord = {
  runId: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  argsSummary: AgentToolCallSummary;
  status: AgentToolCallRecoveryStatus;
  startedAt: string;
  endedAt: string;
  resultSummary?: AgentToolCallSummary;
  errorSummary?: AgentToolCallSummary;
  startedEventId: string;
  finishedEventId?: string;
  interrupted: boolean;
};

export type ProjectToolCallRecordsOptions = {
  /** 用于收口缺少 terminal event 的工具调用。默认使用当前时间。 */
  recoveryTimestamp?: string;
  /** 参数、结果和错误摘要的最大字符数。 */
  summaryLimit?: number;
};

type PendingToolCall = Omit<
  AgentToolCallRecord,
  "status" | "endedAt" | "interrupted"
>;

const DEFAULT_SUMMARY_LIMIT = 500;

/**
 * 从 EventStore 的 run event stream 投影出工具调用记录。
 *
 * EventStore 保持 append-only 事件流；这里提供稳定的恢复视图：
 * - `tool_started` 后接 `tool_finished` 会生成终态记录。
 * - 缺少 `tool_finished` 的调用在恢复视图中标记为 `aborted`，不会暴露为 running。
 * - projection 只读事件，不改变 conversation state。
 */
export function projectToolCallRecordsFromEvents(
  events: readonly AgentStoredEvent[],
  options: ProjectToolCallRecordsOptions = {},
): AgentToolCallRecord[] {
  const summaryLimit = options.summaryLimit ?? DEFAULT_SUMMARY_LIMIT;
  const recoveryTimestamp = options.recoveryTimestamp ?? new Date().toISOString();
  const pending = new Map<string, PendingToolCall>();
  const records: AgentToolCallRecord[] = [];

  for (const event of [...events].sort(compareStoredEvents)) {
    const runtimeEvent = readRuntimeEvent(event.payload);
    if (!runtimeEvent) continue;

    if (runtimeEvent.type === "tool_started") {
      pending.set(runtimeEvent.toolCallId, {
        runId: event.runId,
        sessionId: event.sessionId,
        toolCallId: runtimeEvent.toolCallId,
        toolName: runtimeEvent.toolName,
        argsSummary: summarizeValue(runtimeEvent.args, summaryLimit),
        startedAt: event.createdAt,
        startedEventId: event.eventId,
      });
      continue;
    }

    if (runtimeEvent.type !== "tool_finished") continue;
    const started = pending.get(runtimeEvent.toolCallId);
    if (!started) continue;
    pending.delete(runtimeEvent.toolCallId);

    records.push({
      ...started,
      status: runtimeEvent.isError ? "failed" : "succeeded",
      endedAt: event.createdAt,
      ...(runtimeEvent.isError
        ? { errorSummary: summarizeValue(runtimeEvent.text, summaryLimit) }
        : { resultSummary: summarizeValue(runtimeEvent.text, summaryLimit) }),
      finishedEventId: event.eventId,
      interrupted: false,
    });
  }

  for (const started of [...pending.values()].sort(comparePendingToolCalls)) {
    records.push({
      ...started,
      status: "aborted",
      endedAt: recoveryTimestamp,
      errorSummary: summarizeValue(
        "Tool call had no terminal event before recovery.",
        summaryLimit,
      ),
      interrupted: true,
    });
  }

  return records;
}

export function summarizeValue(
  value: unknown,
  limit = DEFAULT_SUMMARY_LIMIT,
): AgentToolCallSummary {
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  const text = raw === undefined ? String(value) : raw;
  if (text.length <= limit) return { value: text, truncated: false };
  return {
    value: text.slice(0, Math.max(0, limit)),
    truncated: true,
  };
}

function readRuntimeEvent(payload: unknown): AgentRuntimeEvent | undefined {
  if (!payload || typeof payload !== "object" || !("type" in payload)) {
    return undefined;
  }
  return payload as AgentRuntimeEvent;
}

function compareStoredEvents(left: AgentStoredEvent, right: AgentStoredEvent) {
  if (left.runId !== right.runId) return left.runId.localeCompare(right.runId);
  if (left.sequence !== right.sequence) return left.sequence - right.sequence;
  return left.eventId.localeCompare(right.eventId);
}

function comparePendingToolCalls(left: PendingToolCall, right: PendingToolCall) {
  if (left.startedAt !== right.startedAt) return left.startedAt.localeCompare(right.startedAt);
  return left.toolCallId.localeCompare(right.toolCallId);
}
