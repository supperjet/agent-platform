export type AgentEvent = (
  | { type: "run_started" | "run_finished" | "run_aborted"; sessionId: string }
  | { type: "run_failed"; sessionId: string; errorCode: "AGENT_RUN_FAILED"; message: string }
  | { type: "message_started" | "message_finished"; sessionId: string; messageId: string; role: "user" | "assistant"; text: string; messageScope?: "persistent" | "transient" | "unknown" }
  | { type: "assistant_delta"; sessionId: string; messageId: string; delta: string }
  | { type: "tool_policy_checked"; sessionId: string; toolCallId: string; toolName: string; decision: string; reason?: string }
  | { type: "tool_approval_requested"; sessionId: string; toolCallId: string; toolName: string; title: string; message: string; risk?: "low" | "medium" | "high"; reason: string }
  | { type: "tool_approval_approved"; sessionId: string; toolCallId: string; toolName: string }
  | { type: "tool_approval_denied"; sessionId: string; toolCallId: string; toolName: string; reason: string }
  | { type: "tool_started"; sessionId: string; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_progress"; sessionId: string; toolCallId: string; text: string }
  | { type: "tool_finished"; sessionId: string; toolCallId: string; isError: boolean; text: string; sourceIds: string[] }
  | { type: "skill_activation_decided"; sessionId: string; skillName: string; sourceLabel: string; sourceScope: "global" | "project" | "workspace" | "explicit"; decision: "activated" | "rejected"; selectionReason: "explicit_command" | "automatic"; reason: string; disableModelInvocation: boolean; diagnosticCount: number }
  | { type: "skill_policy_checked"; sessionId: string; skillName: string; policy: { kind: "reference" | "template" | "script"; label: string; sourceLabel: string; sourceScope: "global" | "project" | "workspace" | "explicit"; canRead: boolean; canInject: boolean; canExecute: boolean; reason: string } }
  | { type: "skill_composition_decided"; sessionId: string; requestedSkillNames: string[]; knownSkillNames: string[]; unknownSkillNames: string[]; decision: "rejected"; selectionReason: "explicit_command" | "automatic"; reason: string }
) & { receivedAt?: string };

export type AgentMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  streaming: boolean;
  receivedAt: string;
};

export type AgentConsoleState = {
  sessionId: string;
  events: AgentEvent[];
  messages: AgentMessage[];
  isRunning: boolean;
};

export type CommandMode = "prompt" | "steer" | "follow-up";

export type CommandReceipt = {
  accepted: boolean;
  sessionId: string;
  commandId: string;
  type: CommandMode | "abort";
};

export type PublicAgentEvent = {
  eventId: string;
  sequence: number;
  sessionId: string;
  commandId: string;
  type: AgentEvent["type"];
  occurredAt: string;
  payload: Record<string, unknown>;
};

export function createAgentConsoleState(sessionId: string): AgentConsoleState {
  return { sessionId, events: [], messages: [], isRunning: false };
}

export function reduceConsoleEvent(state: AgentConsoleState, input: AgentEvent): AgentConsoleState {
  if (input.sessionId !== state.sessionId) return state;

  const receivedAt = input.receivedAt ?? new Date().toISOString();
  const event: AgentEvent = { ...input, receivedAt };
  const events = [...state.events, event];

  if (
    event.type === "run_started" ||
    event.type === "run_finished" ||
    event.type === "run_aborted" ||
    event.type === "run_failed"
  ) {
    return {
      ...state,
      events,
      isRunning: event.type === "run_started",
      messages: event.type === "run_failed"
        ? state.messages.filter((message) => !message.streaming || message.text.length > 0)
        : state.messages
    };
  }

  if (event.type === "message_started") {
    if (event.messageScope === "transient") {
      return { ...state, events };
    }
    return {
      ...state,
      events,
      messages: [...state.messages, {
        id: event.messageId,
        role: event.role,
        text: event.text,
        streaming: event.role === "assistant",
        receivedAt
      }]
    };
  }

  if (event.type === "assistant_delta") {
    return {
      ...state,
      events,
      messages: state.messages.map((message) => message.id === event.messageId
        ? { ...message, text: message.text + event.delta }
        : message)
    };
  }

  if (event.type === "message_finished") {
    if (event.messageScope === "transient") {
      return { ...state, events };
    }
    return {
      ...state,
      events,
      messages: state.messages.map((message) => message.id === event.messageId
        ? { ...message, text: event.text || message.text, streaming: false }
        : message)
    };
  }

  return { ...state, events };
}

export class AgentServerClient {
  constructor(
    private readonly baseUrl = "",
    private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis)
  ) {}

  async history(sessionId: string): Promise<AgentEvent[]> {
    const response = await this.fetcher(`${this.baseUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}/events`);
    const payload = await readJson<{ events?: PublicAgentEvent[] }>(response);
    return (payload.events ?? []).map(decodePublicEvent);
  }

  async send(sessionId: string, mode: CommandMode, text: string): Promise<CommandReceipt> {
    return this.submitCommand(sessionId, mode, text);
  }

  async abort(sessionId: string): Promise<CommandReceipt> {
    return this.submitCommand(sessionId, "abort");
  }

  eventStreamUrl(sessionId: string): string {
    return `${this.baseUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}/event-stream`;
  }

  private async submitCommand(
    sessionId: string,
    type: CommandMode | "abort",
    text?: string
  ): Promise<CommandReceipt> {
    const response = await this.fetcher(
      `${this.baseUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}/commands`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commandId: crypto.randomUUID(), type, ...(text === undefined ? {} : { text }) })
      }
    );
    return readJson<CommandReceipt>(response);
  }
}

export function decodePublicEvent(event: PublicAgentEvent): AgentEvent {
  return {
    ...event.payload,
    type: event.type,
    sessionId: event.sessionId,
    receivedAt: event.occurredAt
  } as AgentEvent;
}

async function readJson<T>(response: Response): Promise<T> {
  const payload = await response.json() as T & { error?: string | { code: string; message: string } };
  if (!response.ok) {
    const message = typeof payload.error === "object" ? payload.error.message : payload.error;
    throw new Error(message ?? `HTTP ${response.status}`);
  }
  return payload;
}
