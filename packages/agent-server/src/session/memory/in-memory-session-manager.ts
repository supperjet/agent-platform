import { AgentRuntime, AgentRuntimeFactory } from "@agent-platform/agent-core";
import {
  SessionManager,
  type CommandReceipt,
  type SessionAction,
  type SessionSnapshot
} from "../contracts.js";

type ManagedSession = {
  runtime: AgentRuntime;
  promptInFlight: boolean;
  createdAt: number;
  lastActiveAt: number;
};

/** Owns session lifecycle only; it never subscribes to Agent or browser events. */
export class InMemorySessionManager extends SessionManager {
  private readonly sessions = new Map<string, ManagedSession>();

  constructor(private readonly runtimeFactory: AgentRuntimeFactory) {
    super();
  }

  async prompt(sessionId: string, text: string, _commandId: string): Promise<CommandReceipt> {
    const session = this.getOrCreate(sessionId);
    this.assertPromptCanStart(sessionId, session);
    session.promptInFlight = true;
    try {
      const outcome = await session.runtime.execute({ type: "prompt", text });
      return this.receipt("prompt", sessionId, true, outcome);
    } finally {
      session.promptInFlight = false;
      this.touch(session);
    }
  }

  steer(sessionId: string, text: string) {
    return this.executeOnExistingSession(sessionId, "steer", { type: "steer", text });
  }

  followUp(sessionId: string, text: string) {
    return this.executeOnExistingSession(sessionId, "follow-up", { type: "follow-up", text });
  }

  abort(sessionId: string) {
    return this.executeOnExistingSession(sessionId, "abort", { type: "abort" });
  }

  async snapshot(sessionId: string): Promise<SessionSnapshot | undefined> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return undefined;
    }
    const runtime = session.runtime.snapshot();

    return {
      sessionId,
      status: runtime.isRunning ? "running" : "idle",
      createdAt: session.createdAt,
      lastActiveAt: session.lastActiveAt,
      messageCount: runtime.messageCount,
      modelId: runtime.modelId
    };
  }

  private getOrCreate(sessionId: string) {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      return existing;
    }

    const now = Date.now();
    const session: ManagedSession = {
      runtime: this.runtimeFactory.create(sessionId),
      promptInFlight: false,
      createdAt: now,
      lastActiveAt: now
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  private async executeOnExistingSession(
    sessionId: string,
    action: Exclude<SessionAction, "prompt">,
    command: Parameters<AgentRuntime["execute"]>[0]
  ) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return this.receipt(action, sessionId, false, {
        status: "failed",
        errorCode: "SESSION_NOT_FOUND",
        message: `Session "${sessionId}" was not found.`
      });
    }

    const outcome = await session.runtime.execute(command);
    this.touch(session);
    return this.receipt(action, sessionId, true, outcome);
  }

  private assertPromptCanStart(sessionId: string, session: ManagedSession) {
    if (session.promptInFlight) {
      throw new Error(`Session "${sessionId}" is already processing a prompt.`);
    }
  }

  private touch(session: ManagedSession) {
    session.lastActiveAt = Date.now();
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
