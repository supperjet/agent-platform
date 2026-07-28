import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentRuntime,
  AgentRuntimeFactory,
  type AgentConversationState,
  type AgentExecutionOutcome,
  type AgentRuntimeCommand
} from "@agent-platform/agent-core";
import {
  SessionStore,
  type SessionLeaseRequest,
  type CreateSessionResult,
  type SessionRecord
} from "../session/contracts.js";
import { StoredSessionManager } from "../session/mysql/stored-session-manager.js";

test("creates a Session and persists Agent state after a successful prompt", async () => {
  const sessions = new MemorySessionStore();
  const factory = new FakeRuntimeFactory();
  const manager = new StoredSessionManager(factory, sessions, { now: () => 2_000 });

  const receipt = await manager.prompt("session-1", "hello", "command-1");
  const stored = await sessions.find("session-1");

  assert.equal(receipt.outcome.status, "succeeded");
  assert.equal(stored?.status, "idle");
  assert.equal(stored?.version, 1);
  assert.equal(stored?.messageCount, 1);
  assert.deepEqual(readGraphPrompts(stored?.agentState), ["hello"]);
});

test("restores persisted Agent state before executing the next prompt", async () => {
  const original = sessionRecord({
    version: 5,
    agentState: graphState("session-1", ["first"]),
    messageCount: 1
  });
  const sessions = new MemorySessionStore(original);
  const factory = new FakeRuntimeFactory();
  const manager = new StoredSessionManager(factory, sessions, { now: () => 3_000 });

  await manager.prompt("session-1", "second", "command-2");

  assert.deepEqual(factory.restoredStates, [original.agentState]);
  assert.deepEqual(readGraphPrompts((await sessions.find("session-1"))?.agentState), ["first", "second"]);
  assert.equal((await sessions.find("session-1"))?.version, 7);
});

test("persists entry graph Agent state across a restored prompt", async () => {
  const originalState = graphState("session-1", ["first"]);
  const sessions = new MemorySessionStore(sessionRecord({
    version: 5,
    agentState: originalState,
    messageCount: 1
  }));
  const factory = new GraphRuntimeFactory();
  const manager = new StoredSessionManager(factory, sessions, { now: () => 3_500 });

  await manager.prompt("session-1", "second", "command-2");

  const stored = await sessions.find("session-1");
  const payload = assertGraphPayload(stored?.agentState?.payload);
  assert.deepEqual(factory.restoredStates, [originalState]);
  assert.equal("messages" in payload, false);
  assert.equal(payload.entries.length, 2);
  assert.equal(payload.entries[0]?.id, "session-1:entry:1");
  assert.equal(payload.entries[1]?.id, "session-1:entry:2");
  assert.equal(payload.entries[1]?.parentId, "session-1:entry:1");
  assert.equal(payload.leafId, "session-1:entry:2");
  assert.equal(stored?.messageCount, 2);
});

test("preserves the previous Agent state when execution fails", async () => {
  const originalState = graphState("session-1", ["safe"]);
  const sessions = new MemorySessionStore(sessionRecord({ agentState: originalState }));
  const manager = new StoredSessionManager(
    new FakeRuntimeFactory({ status: "failed", errorCode: "MODEL_FAILED", message: "failed" }),
    sessions,
    { now: () => 4_000 }
  );

  const receipt = await manager.prompt("session-1", "not persisted", "command-failed");
  const stored = await sessions.find("session-1");

  assert.equal(receipt.outcome.status, "failed");
  assert.equal(stored?.status, "failed");
  assert.equal(stored?.executingCommandId, undefined);
  assert.deepEqual(stored?.agentState, originalState);
});

test("persists Agent state when prompt execution is aborted", async () => {
  const originalState = graphState("session-1", ["safe"]);
  const sessions = new MemorySessionStore(sessionRecord({
    version: 3,
    agentState: originalState,
    messageCount: 1
  }));
  const manager = new StoredSessionManager(
    new FakeRuntimeFactory({ status: "aborted" }),
    sessions,
    { now: () => 4_250 }
  );

  const receipt = await manager.prompt("session-1", "cancelled prompt", "command-aborted");
  const stored = await sessions.find("session-1");

  assert.equal(receipt.outcome.status, "aborted");
  assert.equal(stored?.status, "idle");
  assert.equal(stored?.executingCommandId, undefined);
  assert.equal(stored?.messageCount, 2);
  assert.deepEqual(readGraphPrompts(stored?.agentState), ["safe", "cancelled prompt"]);
});

test("returns commit failure when completed state cannot be saved", async () => {
  const originalState = graphState("session-1", ["safe"]);
  const sessions = new MemorySessionStore(sessionRecord({
    version: 3,
    agentState: originalState,
    messageCount: 1
  }));
  sessions.failNextSaveForExpectedVersion(4);
  const manager = new StoredSessionManager(
    new FakeRuntimeFactory({ status: "succeeded" }),
    sessions,
    { now: () => 4_375 }
  );

  const receipt = await manager.prompt("session-1", "not committed", "command-commit-failed");
  const stored = await sessions.find("session-1");

  assert.deepEqual(receipt.outcome, {
    status: "commit_failed",
    errorCode: "STATE_COMMIT_FAILED",
    message: "Session \"session-1\" state commit failed while saving version 5."
  });
  assert.equal(stored?.status, "commit_failed");
  assert.equal(stored?.executingCommandId, undefined);
  assert.equal(stored?.messageCount, 2);
  assert.deepEqual(readGraphPrompts(stored?.agentState), ["safe", "not committed"]);
});

test("refuses to continue a Session with an unresolved commit failure", async () => {
  const originalState = graphState("session-1", ["needs repair"]);
  const sessions = new MemorySessionStore(sessionRecord({
    status: "commit_failed",
    version: 7,
    agentState: originalState,
    messageCount: 1
  }));
  const factory = new FakeRuntimeFactory();
  const manager = new StoredSessionManager(factory, sessions, { now: () => 4_400 });

  const receipt = await manager.prompt("session-1", "should wait", "command-after-commit-failed");
  const stored = await sessions.find("session-1");

  assert.deepEqual(receipt, {
    accepted: false,
    sessionId: "session-1",
    action: "prompt",
    outcome: {
      status: "failed",
      errorCode: "SESSION_COMMIT_FAILED",
      message: "Session \"session-1\" has an unresolved state commit failure."
    }
  });
  assert.deepEqual(factory.restoredStates, []);
  assert.equal(stored?.status, "commit_failed");
  assert.equal(stored?.version, 7);
  assert.deepEqual(stored?.agentState, originalState);
});

test("marks the Session failed while preserving state when the runtime throws", async () => {
  const originalState = graphState("session-1", ["safe"]);
  const sessions = new MemorySessionStore(sessionRecord({ agentState: originalState }));
  const manager = new StoredSessionManager(
    new FakeRuntimeFactory(new Error("runtime crashed")),
    sessions,
    { now: () => 4_500 }
  );

  await assert.rejects(
    manager.prompt("session-1", "not persisted", "command-crashed"),
    /runtime crashed/
  );

  const stored = await sessions.find("session-1");
  assert.equal(stored?.status, "failed");
  assert.equal(stored?.executingCommandId, undefined);
  assert.deepEqual(stored?.agentState, originalState);
});

test("routes control commands to the runtime active on this Worker", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const factory = new FakeRuntimeFactory({ status: "succeeded" }, gate);
  const manager = new StoredSessionManager(
    factory,
    new MemorySessionStore(),
    { now: () => 5_000 }
  );

  const prompt = manager.prompt("session-1", "hello", "command-1");
  await new Promise<void>((resolve) => setImmediate(resolve));
  const abort = await manager.abort("session-1");
  release();
  await prompt;

  assert.equal(abort.accepted, true);
  assert.deepEqual(factory.runtimes[0]?.commands.map((command) => command.type), ["prompt", "abort"]);
});

test("rejects a second Prompt while the same Session is being prepared or executed", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const manager = new StoredSessionManager(
    new FakeRuntimeFactory({ status: "succeeded" }, gate),
    new MemorySessionStore(),
    { now: () => 5_500 }
  );

  const first = manager.prompt("session-1", "first", "command-1");
  await assert.rejects(
    manager.prompt("session-1", "second", "command-2"),
    /already processing a prompt/
  );
  release();
  await first;
});

test("allows only one Worker to lease the same Session", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const sessions = new MemorySessionStore(sessionRecord());
  const firstFactory = new FakeRuntimeFactory({ status: "succeeded" }, gate);
  const first = new StoredSessionManager(firstFactory, sessions, {
    now: () => 6_000,
    leaseOwner: "worker-1",
    leaseDurationMs: 1_000
  });
  const second = new StoredSessionManager(
    new FakeRuntimeFactory(),
    sessions,
    { now: () => 6_000, leaseOwner: "worker-2", leaseDurationMs: 1_000 }
  );

  const execution = first.prompt("session-1", "first", "command-1");
  await new Promise<void>((resolve) => setImmediate(resolve));
  await assert.rejects(
    second.prompt("session-1", "second", "command-2"),
    /leased by another Worker/
  );

  release();
  await execution;
  assert.equal((await sessions.find("session-1"))?.executingCommandId, undefined);
});

test("renews the lease so another Worker cannot take over a long Prompt", async () => {
  let now = 20_000;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let triggerRenewal!: () => Promise<boolean>;
  let leaseOwned = true;
  const sessions = new MemorySessionStore(sessionRecord());
  const first = new StoredSessionManager(
    new FakeRuntimeFactory({ status: "succeeded" }, gate),
    sessions,
    {
      now: () => now,
      leaseOwner: "worker-1",
      leaseDurationMs: 300,
      startLeaseRenewal: (renew) => {
        triggerRenewal = async () => {
          leaseOwned = leaseOwned && await renew();
          return leaseOwned;
        };
        return { stop: async () => leaseOwned };
      }
    }
  );
  const second = new StoredSessionManager(
    new FakeRuntimeFactory(),
    sessions,
    { now: () => now, leaseOwner: "worker-2", leaseDurationMs: 300 }
  );

  const execution = first.prompt("session-1", "long", "command-1");
  await new Promise<void>((resolve) => setImmediate(resolve));
  now = 20_200;
  assert.equal(await triggerRenewal(), true);
  now = 20_400;
  await assert.rejects(
    second.prompt("session-1", "overlap", "command-2"),
    /leased by another Worker/
  );

  release();
  await execution;
});

test("aborts the runtime and refuses to save after lease renewal is lost", async () => {
  let now = 30_000;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let triggerRenewal!: () => Promise<void>;
  let leaseOwned = true;
  const factory = new FakeRuntimeFactory({ status: "succeeded" }, gate);
  const manager = new StoredSessionManager(factory, new MemorySessionStore(sessionRecord()), {
    now: () => now,
    leaseOwner: "worker-1",
    leaseDurationMs: 100,
    startLeaseRenewal: (renew, _interval, onLeaseLost) => {
      triggerRenewal = async () => {
        leaseOwned = await renew();
        if (!leaseOwned) onLeaseLost();
      };
      return { stop: async () => leaseOwned };
    }
  });

  const execution = manager.prompt("session-1", "long", "command-1");
  await new Promise<void>((resolve) => setImmediate(resolve));
  now = 30_200;
  await triggerRenewal();
  release();

  await assert.rejects(execution, /lease was lost/);
  assert.deepEqual(factory.runtimes[0]?.commands.map((command) => command.type), ["prompt", "abort"]);
});

test("fences an old Worker after its lease expires and another Worker takes over", async () => {
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const sessions = new MemorySessionStore(sessionRecord());
  const first = new StoredSessionManager(
    new FakeRuntimeFactory({ status: "succeeded" }, firstGate),
    sessions,
    { now: () => 10_000, leaseOwner: "worker-old", leaseDurationMs: 500 }
  );
  const replacement = new StoredSessionManager(
    new FakeRuntimeFactory(),
    sessions,
    { now: () => 11_000, leaseOwner: "worker-new", leaseDurationMs: 500 }
  );

  const oldExecution = first.prompt("session-1", "old", "command-old");
  await new Promise<void>((resolve) => setImmediate(resolve));
  await replacement.prompt("session-1", "new", "command-new");
  releaseFirst();

  assert.equal((await oldExecution).outcome.status, "commit_failed");
  assert.deepEqual(readGraphPrompts((await sessions.find("session-1"))?.agentState), ["new"]);
});

test("reads Session snapshots from durable storage", async () => {
  const manager = new StoredSessionManager(
    new FakeRuntimeFactory(),
    new MemorySessionStore(sessionRecord({ status: "failed", messageCount: 3 })),
    { now: () => 6_000 }
  );

  assert.deepEqual(await manager.snapshot("session-1"), {
    sessionId: "session-1",
    status: "failed",
    createdAt: 1_000,
    lastActiveAt: 1_000,
    messageCount: 3,
    modelId: "test-model"
  });
});

class MemorySessionStore extends SessionStore {
  private readonly records = new Map<string, SessionRecord>();
  private readonly failingSaveExpectedVersions = new Map<number, number>();

  constructor(initial?: SessionRecord) {
    super();
    if (initial) this.records.set(initial.sessionId, structuredClone(initial));
  }

  async createIfAbsent(session: SessionRecord): Promise<CreateSessionResult> {
    const existing = this.records.get(session.sessionId);
    if (existing) return { created: false, session: structuredClone(existing) };
    this.records.set(session.sessionId, structuredClone(session));
    return { created: true, session: structuredClone(session) };
  }

  async find(sessionId: string) {
    const session = this.records.get(sessionId);
    return session ? structuredClone(session) : undefined;
  }

  async acquireExecutionLease(lease: SessionLeaseRequest) {
    const current = this.records.get(lease.sessionId);
    if (
      !current
      || current.status === "closed"
      || current.status === "commit_failed"
      || (current.leaseUntil !== undefined && current.leaseUntil > lease.now)
    ) {
      return undefined;
    }
    const leased: SessionRecord = {
      ...withoutLease(current),
      status: "running",
      version: current.version + 1,
      executingCommandId: lease.commandId,
      leaseOwner: lease.leaseOwner,
      leaseUntil: lease.leaseUntil,
      lastActiveAt: lease.now,
      updatedAt: lease.now
    };
    this.records.set(lease.sessionId, structuredClone(leased));
    return structuredClone(leased);
  }

  async renewExecutionLease(lease: SessionLeaseRequest) {
    const current = this.records.get(lease.sessionId);
    if (
      !current
      || current.executingCommandId !== lease.commandId
      || current.leaseOwner !== lease.leaseOwner
      || current.leaseUntil === undefined
      || current.leaseUntil <= lease.now
    ) {
      return false;
    }
    this.records.set(lease.sessionId, {
      ...current,
      leaseUntil: lease.leaseUntil,
      updatedAt: lease.now
    });
    return true;
  }

  async save(session: SessionRecord, expectedVersion: number) {
    const remainingFailures = this.failingSaveExpectedVersions.get(expectedVersion) ?? 0;
    if (remainingFailures > 0) {
      this.failingSaveExpectedVersions.set(expectedVersion, remainingFailures - 1);
      return false;
    }
    const current = this.records.get(session.sessionId);
    if (!current || current.version !== expectedVersion) return false;
    this.records.set(session.sessionId, structuredClone(session));
    return true;
  }

  failNextSaveForExpectedVersion(expectedVersion: number) {
    this.failingSaveExpectedVersions.set(
      expectedVersion,
      (this.failingSaveExpectedVersions.get(expectedVersion) ?? 0) + 1
    );
  }
}

function withoutLease(session: SessionRecord) {
  const {
    executingCommandId: _executingCommandId,
    leaseOwner: _leaseOwner,
    leaseUntil: _leaseUntil,
    ...record
  } = session;
  return record;
}

class FakeRuntimeFactory extends AgentRuntimeFactory {
  readonly restoredStates: Array<AgentConversationState | undefined> = [];
  readonly runtimes: FakeRuntime[] = [];

  constructor(
    private readonly result: AgentExecutionOutcome | Error = { status: "succeeded" },
    private readonly promptGate?: Promise<void>
  ) {
    super();
  }

  create(_sessionId: string, restoredState?: AgentConversationState) {
    this.restoredStates.push(restoredState);
    const runtime = new FakeRuntime(restoredState, this.result, this.promptGate);
    this.runtimes.push(runtime);
    return runtime;
  }
}

class FakeRuntime extends AgentRuntime {
  readonly commands: AgentRuntimeCommand[] = [];
  private readonly prompts: string[];

  constructor(
    restoredState: AgentConversationState | undefined,
    private readonly result: AgentExecutionOutcome | Error,
    private readonly promptGate?: Promise<void>
  ) {
    super();
    this.prompts = readGraphPrompts(restoredState);
  }

  async execute(command: AgentRuntimeCommand) {
    this.commands.push(command);
    if (command.type === "prompt") {
      this.prompts.push(command.text);
      await this.promptGate;
      if (this.result instanceof Error) throw this.result;
      return this.result;
    }
    return { status: "succeeded" } as const;
  }

  snapshot() {
    return {
      messageCount: this.prompts.length,
      transcriptRoles: this.prompts.map(() => "user"),
      isRunning: false,
      modelId: "test-model"
    };
  }

  exportState() {
    return graphState("session-1", [...this.prompts]);
  }

  subscribe() {
    return () => {};
  }
}

type GraphEntry = {
  kind: "message";
  id: string;
  parentId: string | null;
  createdAt: string;
  payload: {
    message: { role: "user"; text: string };
  };
};

type GraphPayload = {
  entries: GraphEntry[];
  leafId: string | null;
};

class GraphRuntimeFactory extends AgentRuntimeFactory {
  readonly restoredStates: Array<AgentConversationState | undefined> = [];

  create(sessionId: string, restoredState?: AgentConversationState) {
    this.restoredStates.push(restoredState);
    return new GraphRuntime(sessionId, restoredState);
  }
}

class GraphRuntime extends AgentRuntime {
  private readonly entries: GraphEntry[];
  private leafId: string | null;

  constructor(
    private readonly sessionId: string,
    restoredState: AgentConversationState | undefined
  ) {
    super();
    const payload = restoredState?.payload ? assertGraphPayload(restoredState.payload) : {
      entries: [],
      leafId: null
    };
    this.entries = structuredClone(payload.entries);
    this.leafId = payload.leafId;
  }

  async execute(command: AgentRuntimeCommand) {
    if (command.type === "prompt") {
      const id = `${this.sessionId}:entry:${this.entries.length + 1}`;
      this.entries.push({
        kind: "message",
        id,
        parentId: this.leafId,
        createdAt: new Date(0).toISOString(),
        payload: {
          message: { role: "user", text: command.text }
        }
      });
      this.leafId = id;
    }
    return { status: "succeeded" } as const;
  }

  snapshot() {
    return {
      messageCount: this.entries.length,
      transcriptRoles: this.entries.map((entry) => entry.payload.message.role),
      isRunning: false,
      modelId: "test-model"
    };
  }

  exportState() {
    return graphStateFromPayload({
      entries: this.entries,
      leafId: this.leafId
    });
  }

  subscribe() {
    return () => {};
  }
}

function graphState(sessionId: string, prompts: string[]): AgentConversationState {
  let parentId: string | null = null;
  const entries = prompts.map((prompt, index) => {
    const id = `${sessionId}:entry:${index + 1}`;
    const entry: GraphEntry = {
      kind: "message",
      id,
      parentId,
      createdAt: new Date(0).toISOString(),
      payload: {
        message: { role: "user", text: prompt }
      }
    };
    parentId = id;
    return entry;
  });
  return graphStateFromPayload({
    entries,
    leafId: entries.at(-1)?.id ?? null
  });
}

function graphStateFromPayload(payload: GraphPayload): AgentConversationState {
  return {
    schemaVersion: 2,
    modelId: "test-model",
    payload: {
      entries: structuredClone(payload.entries),
      leafId: payload.leafId
    }
  };
}

function readGraphPrompts(state: AgentConversationState | undefined): string[] {
  if (!state) return [];
  const payload = assertGraphPayload(state.payload);
  return payload.entries.map((entry) => entry.payload.message.text);
}

function assertGraphPayload(payload: unknown): GraphPayload {
  if (!payload || typeof payload !== "object") {
    assert.fail("Expected graph payload object.");
  }
  assert.equal("entries" in payload, true);
  assert.equal("leafId" in payload, true);
  const candidate = payload as GraphPayload;
  assert.equal(Array.isArray(candidate.entries), true);
  assert.equal(candidate.leafId === null || typeof candidate.leafId === "string", true);
  return candidate;
}

function sessionRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: "session-1",
    status: "idle",
    modelId: "test-model",
    agentState: graphState("session-1", []),
    messageCount: 0,
    version: 0,
    createdAt: 1_000,
    lastActiveAt: 1_000,
    updatedAt: 1_000,
    ...overrides
  };
}
