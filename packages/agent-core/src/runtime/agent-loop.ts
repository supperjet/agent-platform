import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";

export type AgentLoopSnapshot = {
  messages: readonly AgentMessage[];
  isStreaming: boolean;
  modelId: string;
};

export type AgentLoop = {
  prompt(message: AgentMessage | AgentMessage[]): Promise<void>;
  continue(): Promise<void>;
  steer(message: AgentMessage): void;
  followUp(message: AgentMessage): void;
  abort(): void;
  waitForIdle(): Promise<void>;
  subscribe(listener: (event: AgentEvent) => void): () => void;
  snapshot(): AgentLoopSnapshot;
};
