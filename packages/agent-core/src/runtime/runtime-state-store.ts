import type { AgentRuntimeCommand } from "../contracts.js";

export type AgentRuntimeSessionStatus =
  | "idle"
  | "running"
  | "aborting"
  | "failed"
  | "commit_failed"
  | "interrupted";

export type AgentRuntimeDirtyState =
  | "clean"
  | "dirty"
  | "commit_failed";

export type AgentQueuedRuntimeCommand = {
  commandId: string;
  command: AgentRuntimeCommand;
  queuedAt: string;
};

export type AgentActiveRuntimeCommand = {
  commandId: string;
  runId?: string;
  command: AgentRuntimeCommand;
  startedAt: string;
};

/**
 * session 级可恢复运行快照。
 *
 * 它描述“运行容器现在处于什么状态”，不替代 AgentConversationState。
 * active command 在跨进程恢复时默认只能被标记 interrupted，不能原地续跑。
 */
export type AgentRuntimeStateSnapshot = {
  snapshotId: string;
  sessionId: string;
  status: AgentRuntimeSessionStatus;
  dirtyState: AgentRuntimeDirtyState;
  activeCommand?: AgentActiveRuntimeCommand;
  queuedCommands: readonly AgentQueuedRuntimeCommand[];
  lastCommittedStateVersion?: number;
  updatedAt: string;
};

export type AgentRuntimeRecoveryStatus =
  | "clean"
  | "dirty"
  | "commit_failed"
  | "interrupted";

export type AgentQueuedPromptRecoveryPolicy =
  | "discard"
  | "preserve"
  | "host_decides";

export type AgentRuntimeRecoveryAssessment = {
  sessionId: string;
  status: AgentRuntimeRecoveryStatus;
  shouldResumeActiveCommand: false;
  interruptedCommand?: AgentActiveRuntimeCommand;
  queuedCommands: readonly AgentQueuedRuntimeCommand[];
  queuedPromptPolicy: AgentQueuedPromptRecoveryPolicy;
  reason: string;
};

export type AgentRuntimeLogEntryType =
  | "runtime_snapshot_saved"
  | "command_accepted"
  | "command_finished"
  | "command_interrupted"
  | "queue_changed"
  | "state_commit_failed";

export type AgentRuntimeLogEntry = {
  entryId: string;
  sessionId: string;
  sequence: number;
  type: AgentRuntimeLogEntryType;
  payload: unknown;
  createdAt: string;
};

export abstract class RuntimeStateStore {
  abstract save(snapshot: AgentRuntimeStateSnapshot): Promise<AgentRuntimeStateSnapshot>;
  abstract get(sessionId: string): Promise<AgentRuntimeStateSnapshot | undefined>;
  abstract delete(sessionId: string): Promise<boolean>;
}

export abstract class RuntimeLogStore {
  abstract append(entry: AgentRuntimeLogEntry): Promise<AgentRuntimeLogEntry>;
  abstract listBySession(sessionId: string): Promise<AgentRuntimeLogEntry[]>;
}

export class InMemoryRuntimeStateStore extends RuntimeStateStore {
  private readonly snapshots = new Map<string, AgentRuntimeStateSnapshot>();

  async save(snapshot: AgentRuntimeStateSnapshot): Promise<AgentRuntimeStateSnapshot> {
    const copy = cloneRuntimeStateSnapshot(snapshot);
    this.snapshots.set(snapshot.sessionId, copy);
    return cloneRuntimeStateSnapshot(copy);
  }

  async get(sessionId: string): Promise<AgentRuntimeStateSnapshot | undefined> {
    const snapshot = this.snapshots.get(sessionId);
    return snapshot ? cloneRuntimeStateSnapshot(snapshot) : undefined;
  }

  async delete(sessionId: string): Promise<boolean> {
    return this.snapshots.delete(sessionId);
  }
}

export class InMemoryRuntimeLogStore extends RuntimeLogStore {
  private readonly entries = new Map<string, AgentRuntimeLogEntry>();

  async append(entry: AgentRuntimeLogEntry): Promise<AgentRuntimeLogEntry> {
    if (this.entries.has(entry.entryId)) {
      throw new Error(`Runtime log entry "${entry.entryId}" already exists.`);
    }
    const sequenceConflict = [...this.entries.values()].find(
      (existing) =>
        existing.sessionId === entry.sessionId &&
        existing.sequence === entry.sequence,
    );
    if (sequenceConflict) {
      throw new Error(
        `Runtime log sequence ${entry.sequence} already exists for Session "${entry.sessionId}".`,
      );
    }
    const copy = { ...entry };
    this.entries.set(entry.entryId, copy);
    return { ...copy };
  }

  async listBySession(sessionId: string): Promise<AgentRuntimeLogEntry[]> {
    return [...this.entries.values()]
      .filter((entry) => entry.sessionId === sessionId)
      .sort(compareRuntimeLogEntries)
      .map((entry) => ({ ...entry }));
  }
}

export function assessRuntimeRecovery(
  snapshot: AgentRuntimeStateSnapshot,
  options: {
    queuedPromptPolicy?: AgentQueuedPromptRecoveryPolicy;
  } = {},
): AgentRuntimeRecoveryAssessment {
  const queuedPromptPolicy = options.queuedPromptPolicy ?? "host_decides";

  if (snapshot.dirtyState === "commit_failed" || snapshot.status === "commit_failed") {
    return {
      sessionId: snapshot.sessionId,
      status: "commit_failed",
      shouldResumeActiveCommand: false,
      ...(snapshot.activeCommand ? { interruptedCommand: snapshot.activeCommand } : {}),
      queuedCommands: snapshot.queuedCommands,
      queuedPromptPolicy,
      reason: "Last runtime state is commit_failed; host must repair or discard before continuing.",
    };
  }

  if (snapshot.activeCommand || snapshot.status === "running" || snapshot.status === "aborting") {
    return {
      sessionId: snapshot.sessionId,
      status: "interrupted",
      shouldResumeActiveCommand: false,
      ...(snapshot.activeCommand ? { interruptedCommand: snapshot.activeCommand } : {}),
      queuedCommands: snapshot.queuedCommands,
      queuedPromptPolicy,
      reason: "Runtime had an active command; recovery marks it interrupted and does not replay it.",
    };
  }

  if (snapshot.dirtyState === "dirty") {
    return {
      sessionId: snapshot.sessionId,
      status: "dirty",
      shouldResumeActiveCommand: false,
      queuedCommands: snapshot.queuedCommands,
      queuedPromptPolicy,
      reason: "Runtime state is dirty; host must decide whether the latest exported state is durable.",
    };
  }

  return {
    sessionId: snapshot.sessionId,
    status: "clean",
    shouldResumeActiveCommand: false,
    queuedCommands: snapshot.queuedCommands,
    queuedPromptPolicy,
    reason: "Runtime state is clean and can be restored from canonical conversation state.",
  };
}

function cloneRuntimeStateSnapshot(
  snapshot: AgentRuntimeStateSnapshot,
): AgentRuntimeStateSnapshot {
  return {
    ...snapshot,
    ...(snapshot.activeCommand
      ? {
          activeCommand: {
            ...snapshot.activeCommand,
            command: { ...snapshot.activeCommand.command },
          },
        }
      : {}),
    queuedCommands: snapshot.queuedCommands.map((queued) => ({
      ...queued,
      command: { ...queued.command },
    })),
  };
}

function compareRuntimeLogEntries(
  left: AgentRuntimeLogEntry,
  right: AgentRuntimeLogEntry,
): number {
  if (left.sequence !== right.sequence) return left.sequence - right.sequence;
  return left.entryId.localeCompare(right.entryId);
}
