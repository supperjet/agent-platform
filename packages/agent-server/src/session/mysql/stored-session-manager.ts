import { randomUUID } from "node:crypto";
import { AgentRuntime, AgentRuntimeFactory } from "@agent-platform/agent-core";
import {
  SessionManager,
  type CommandReceipt,
  type SessionAction,
  type SessionRecord,
  type SessionSnapshot,
  type SessionStore
} from "../contracts.js";

type ActiveSession = {
  runtime: AgentRuntime;
};

const DEFAULT_LEASE_DURATION_MS = 5 * 60 * 1_000;

export type LeaseRenewal = {
  stop(): Promise<boolean>;
};

export type StoredSessionManagerOptions = {
  now?: () => number;
  leaseOwner?: string;
  leaseDurationMs?: number;
  startLeaseRenewal?: (
    renew: () => Promise<boolean>,
    intervalMs: number,
    onLeaseLost: () => void
  ) => LeaseRenewal;
};

/** Restores one runtime per execution and persists its Agent state through SessionStore. */
export class StoredSessionManager extends SessionManager {
  /*
   * Prompt 执行流程：
   *
   * promptSessions.add(sessionId)        从入口占位，覆盖准备和执行全过程
   *   -> 从 SessionStore 查询 Session
   *   -> 恢复 agentState / 创建 runtime
   *   -> 原子获取数据库执行租约，并将 Session 标记为 running
   *   -> activeSessions.set(sessionId)   runtime 已就绪，可接收 steer/follow-up/abort
   *   -> 执行 Prompt
   *   -> 成功时保存新 agentState，失败时保留执行前状态
   *   -> activeSessions.delete(sessionId)
   * promptSessions.delete(sessionId)     释放本进程内的 Prompt 执行权
   *
   * promptSessions 防止同一 Session 在异步查询 MySQL 期间重复进入；
   * activeSessions 保存当前 Worker 内可被控制命令操作的 runtime。
   * 两者处理单进程并发，SessionStore 执行租约负责跨 Worker 互斥。
   */
  private readonly activeSessions = new Map<string, ActiveSession>();
  private readonly promptSessions = new Set<string>();
  private readonly now: () => number;
  private readonly leaseOwner: string;
  private readonly leaseDurationMs: number;
  private readonly startRenewal: NonNullable<StoredSessionManagerOptions["startLeaseRenewal"]>;

  constructor(
    private readonly runtimeFactory: AgentRuntimeFactory,
    private readonly sessions: SessionStore,
    options: StoredSessionManagerOptions = {}
  ) {
    super();
    this.now = options.now ?? Date.now;
    this.leaseOwner = options.leaseOwner ?? randomUUID();
    this.leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    this.startRenewal = options.startLeaseRenewal ?? startLeaseRenewal;
  }

  async prompt(sessionId: string, text: string, commandId: string): Promise<CommandReceipt> {
    if (this.promptSessions.has(sessionId)) {
      throw new Error(`Session "${sessionId}" is already processing a prompt.`);
    }
    this.promptSessions.add(sessionId);
    try {
      return await this.executePrompt(sessionId, commandId, text);
    } finally {
      this.activeSessions.delete(sessionId);
      this.promptSessions.delete(sessionId);
    }
  }

  private async executePrompt(
    sessionId: string,
    commandId: string,
    text: string
  ): Promise<CommandReceipt> {
    const prepared = await this.preparePrompt(sessionId, commandId);
    if (!prepared) {
      return this.failure("prompt", sessionId, "SESSION_CLOSED", `Session "${sessionId}" is closed.`);
    }

    const { runtime, record } = prepared;
    this.activeSessions.set(sessionId, { runtime });
    // 启动租约续期
    const renewal = this.startRenewal(
      () => this.renewLease(record),
      Math.max(1, Math.floor(this.leaseDurationMs / 3)),
      () => { void runtime.execute({ type: "abort" }).catch(() => {}); }
    );
    // 执行 Prompt
    let outcome: CommandReceipt["outcome"];
    try {
      outcome = await runtime.execute({ type: "prompt", text });
    } catch (error) {
      // 停止租约续期
      const leaseOwned = await renewal.stop();
      if (!leaseOwned) throw leaseLost(sessionId, commandId);
      const failedAt = this.now();
      await this.saveNext({
        ...withoutExecutionLease(record),
        status: "failed",
        version: record.version + 1,
        lastActiveAt: failedAt,
        updatedAt: failedAt
      }, record.version);
      throw error;
    }
    if (!await renewal.stop()) throw leaseLost(sessionId, commandId);
    const snapshot = runtime.snapshot();
    const completedAt = this.now();
    const next: SessionRecord = outcome.status === "succeeded"
      ? {
        ...withoutExecutionLease(record),
        status: "idle",
        agentState: runtime.exportState(),
        messageCount: snapshot.messageCount,
        version: record.version + 1,
        lastActiveAt: completedAt,
        updatedAt: completedAt
      }
      : {
        ...withoutExecutionLease(record),
        status: "failed",
        version: record.version + 1,
        lastActiveAt: completedAt,
        updatedAt: completedAt
      };
    await this.saveNext(next, record.version);
    return this.receipt("prompt", sessionId, true, outcome);
  }

  steer(sessionId: string, text: string) {
    return this.executeControl(sessionId, "steer", { type: "steer", text });
  }

  followUp(sessionId: string, text: string) {
    return this.executeControl(sessionId, "follow-up", { type: "follow-up", text });
  }

  abort(sessionId: string) {
    return this.executeControl(sessionId, "abort", { type: "abort" });
  }

  async snapshot(sessionId: string): Promise<SessionSnapshot | undefined> {
    const record = await this.sessions.find(sessionId);
    return record ? {
      sessionId: record.sessionId,
      status: record.status,
      createdAt: record.createdAt,
      lastActiveAt: record.lastActiveAt,
      messageCount: record.messageCount,
      modelId: record.modelId
    } : undefined;
  }

  private async preparePrompt(sessionId: string, commandId: string) {
    const existing = await this.sessions.find(sessionId);
    if (existing?.status === "closed") return undefined;
    if (existing) return this.acquireExisting(existing.sessionId, commandId);

    // 不存在则创建
    const runtime = this.runtimeFactory.create(sessionId);
    const timestamp = this.now();
    const snapshot = runtime.snapshot();
    const candidate: SessionRecord = {
      sessionId,
      status: "running",
      modelId: snapshot.modelId,
      agentState: runtime.exportState(),
      messageCount: snapshot.messageCount,
      version: 0,
      executingCommandId: commandId,
      leaseOwner: this.leaseOwner,
      leaseUntil: timestamp + this.leaseDurationMs,
      createdAt: timestamp,
      lastActiveAt: timestamp,
      updatedAt: timestamp
    };
    const creation = await this.sessions.createIfAbsent(candidate);
    if (creation.created) return { runtime, record: creation.session };
    if (creation.session.status === "closed") return undefined;
    return this.acquireExisting(creation.session.sessionId, commandId);
  }

  private async acquireExisting(sessionId: string, commandId: string) {
    const timestamp = this.now();
    const record = await this.sessions.acquireExecutionLease({
      sessionId,
      commandId,
      leaseOwner: this.leaseOwner,
      now: timestamp,
      leaseUntil: timestamp + this.leaseDurationMs
    });
    if (!record) {
      throw new Error(`Session "${sessionId}" is leased by another Worker.`);
    }
    let runtime: AgentRuntime;
    try {
      runtime = this.runtimeFactory.create(record.sessionId, record.agentState);
    } catch (error) {
      await this.saveNext({
        ...withoutExecutionLease(record),
        status: "failed",
        version: record.version + 1,
        updatedAt: timestamp
      }, record.version);
      throw error;
    }
    return {
      runtime,
      record
    };
  }

  private renewLease(session: SessionRecord) {
    const timestamp = this.now();
    return this.sessions.renewExecutionLease({
      sessionId: session.sessionId,
      commandId: session.executingCommandId!,
      leaseOwner: session.leaseOwner!,
      now: timestamp,
      leaseUntil: timestamp + this.leaseDurationMs
    });
  }

  private async executeControl(
    sessionId: string,
    action: Exclude<SessionAction, "prompt">,
    command: Parameters<AgentRuntime["execute"]>[0]
  ) {
    const active = this.activeSessions.get(sessionId);
    if (!active) {
      return this.failure(
        action,
        sessionId,
        "SESSION_NOT_ACTIVE",
        `Session "${sessionId}" is not active on this Worker.`
      );
    }
    const outcome = await active.runtime.execute(command);
    return this.receipt(action, sessionId, true, outcome);
  }

  private async saveNext(session: SessionRecord, expectedVersion: number) {
    if (!await this.sessions.save(session, expectedVersion)) {
      throw new Error(
        `Session "${session.sessionId}" changed while saving version ${session.version}.`
      );
    }
  }

  private failure(
    action: SessionAction,
    sessionId: string,
    errorCode: string,
    message: string
  ) {
    return this.receipt(action, sessionId, false, { status: "failed", errorCode, message });
  }

  private receipt(
    action: SessionAction,
    sessionId: string,
    accepted: boolean,
    outcome: CommandReceipt["outcome"]
  ): CommandReceipt {
    return { accepted, sessionId, action, outcome };
  }
}

function withoutExecutionLease(session: SessionRecord) {
  const {
    executingCommandId: _executingCommandId,
    leaseOwner: _leaseOwner,
    leaseUntil: _leaseUntil,
    ...record
  } = session;
  return record;
}

function startLeaseRenewal(
  renew: () => Promise<boolean>,
  intervalMs: number,
  onLeaseLost: () => void
): LeaseRenewal {
  let stopped = false;
  let leaseOwned = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight = Promise.resolve();

  const loseLease = () => {
    if (!leaseOwned) return;
    leaseOwned = false;
    onLeaseLost();
  };

  const schedule = () => {
    timer = setTimeout(() => {
      inFlight = renew()
        .then((renewed) => { if (!renewed) loseLease(); })
        .catch(loseLease)
        .finally(() => {
          if (!stopped && leaseOwned) schedule();
        });
    }, intervalMs);
    timer.unref?.();
  };
  schedule();

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await inFlight;
      return leaseOwned;
    }
  };
}

function leaseLost(sessionId: string, commandId: string) {
  return new Error(`Session "${sessionId}" lease was lost while executing Command "${commandId}".`);
}
