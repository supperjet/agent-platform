import type { AgentConversationState, AgentExecutionOutcome } from "@agent-platform/agent-core";

export type CommandType = "prompt" | "steer" | "follow-up" | "abort";
export type SessionAction = CommandType;

export type CommandStatus =
  | "accepted"
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type SessionStatus = "idle" | "running" | "failed" | "commit_failed" | "closed";

export type SessionExecutionLease =
  | { executingCommandId: string; leaseOwner: string; leaseUntil: number }
  | { executingCommandId?: never; leaseOwner?: never; leaseUntil?: never };

export type SessionLeaseRequest = {
  sessionId: string;
  commandId: string;
  leaseOwner: string;
  now: number;
  leaseUntil: number;
};

/** Durable server-owned metadata and the opaque Agent Core state for one Session. */
export type SessionRecord = {
  sessionId: string;
  status: SessionStatus;
  modelId: string;
  agentState?: AgentConversationState;
  messageCount: number;
  version: number;
  createdAt: number;
  lastActiveAt: number;
  updatedAt: number;
  closedAt?: number;
} & SessionExecutionLease;

export type CreateSessionResult =
  | { created: true; session: SessionRecord }
  | { created: false; session: SessionRecord };

export type ExecutionLogLevel = "info" | "error";

export type ExecutionLogEntry = {
  event: string;
  commandId?: string;
  sessionId?: string;
  commandType?: CommandType;
  jobId?: string;
  attempt?: number;
  status?: CommandStatus;
  errorCode?: string;
  errorMessage?: string;
  error?: unknown;
};

export type ExecutionLogger = {
  log(level: ExecutionLogLevel, entry: ExecutionLogEntry): void;
};

export type CommandRecord = {
  commandId: string;
  sessionId: string;
  type: CommandType;
  text?: string;
  accepted?: boolean;
  status: CommandStatus;
  createdAt: number;
  updatedAt: number;
};

export type CreateCommandResult =
  | { created: true; command: CommandRecord }
  | { created: false; command: CommandRecord };

export type CommandReceipt = {
  accepted: boolean;
  sessionId: string;
  action: SessionAction;
  outcome: AgentExecutionOutcome;
};

export type SessionSnapshot = {
  sessionId: string;
  status: SessionStatus;
  createdAt: number;
  lastActiveAt: number;
  messageCount: number;
  modelId: string;
};

export type SubmitCommand = {
  sessionId: string;
  commandId: string;
  type: CommandType;
  text?: string;
};

export type SubmittedCommand = {
  accepted: boolean;
  sessionId: string;
  commandId: string;
  type: CommandType;
};

export type SessionView = {
  sessionId: string;
  status: SessionStatus;
  createdAt: string;
  lastActiveAt: string;
  messageCount: number;
  modelId: string;
};

export abstract class SessionQuery {
  abstract snapshot(sessionId: string): Promise<SessionSnapshot | undefined>;
}

export abstract class SessionManager extends SessionQuery {
  abstract prompt(sessionId: string, text: string, commandId: string): Promise<CommandReceipt>;
  abstract steer(sessionId: string, text: string): Promise<CommandReceipt>;
  abstract followUp(sessionId: string, text: string): Promise<CommandReceipt>;
  abstract abort(sessionId: string): Promise<CommandReceipt>;
}

export abstract class SessionStore {
  abstract createIfAbsent(session: SessionRecord): Promise<CreateSessionResult>;
  abstract find(sessionId: string): Promise<SessionRecord | undefined>;
  abstract acquireExecutionLease(lease: SessionLeaseRequest): Promise<SessionRecord | undefined>;
  abstract renewExecutionLease(lease: SessionLeaseRequest): Promise<boolean>;

  /** Replaces a Session only when its stored version matches expectedVersion. */
  abstract save(session: SessionRecord, expectedVersion: number): Promise<boolean>;
}

export abstract class SessionApplication {
  abstract submitCommand(command: SubmitCommand): Promise<SubmittedCommand>;
  abstract getSession(sessionId: string): Promise<SessionView | undefined>;
  abstract getCommand(commandId: string): Promise<CommandRecord | undefined>;
  abstract close(): Promise<void>;
}

export abstract class CommandRepository {
  abstract createIfAbsent(command: CommandRecord): Promise<CreateCommandResult>;
  abstract save(command: CommandRecord): Promise<void>;
  abstract find(commandId: string): Promise<CommandRecord | undefined>;
}

export abstract class CommandSubmissionStore {
  /** Creates the queued command if absent; durable adapters also record its delivery atomically. */
  abstract createQueuedIfAbsent(command: SubmitCommand): Promise<CreateCommandResult>;
}

export type DispatchCommand = Pick<CommandRecord, "commandId" | "sessionId" | "type">;

export type OutboxClaim = {
  eventId: string;
  commandId: string;
  leaseId: string;
  attempts: number;
};

export abstract class OutboxStore {
  abstract claimNext(now: number, leaseDurationMs: number): Promise<OutboxClaim | undefined>;
  abstract markPublished(claim: OutboxClaim, publishedAt: number): Promise<void>;
  abstract reschedule(claim: OutboxClaim, error: string, availableAt: number): Promise<void>;
}

export abstract class CommandRunner {
  /** Reloads the command from CommandRepository, executes it, and persists its final status. */
  abstract executeById(commandId: string): Promise<void>;
}

export abstract class ExecutionDispatcher {
  /** Enqueues an already-persisted command for asynchronous execution. */
  abstract enqueue(command: DispatchCommand): Promise<void>;
  abstract ready(): Promise<void>;
  abstract close(): Promise<void>;
}
