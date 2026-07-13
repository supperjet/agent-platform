import { Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import type { AgentModel } from "../contracts.js";
import type { AgentLoop, AgentLoopSnapshot } from "./agent-loop.js";

export type AgentLoopAdapterOptions = {
  systemPrompt: string;
  model: AgentModel;
  messages: readonly AgentMessage[];
  tools: readonly AgentTool[];
  getApiKey: (provider: string) => Promise<string | undefined>;
};

export class AgentLoopAdapter implements AgentLoop {
  private readonly agent: Agent;

  constructor(options: AgentLoopAdapterOptions) {
    this.agent = new Agent({
      initialState: {
        systemPrompt: options.systemPrompt,
        model: options.model,
        messages: [...options.messages],
        tools: [...options.tools]
      },
      getApiKey: options.getApiKey
    });
  }

  async prompt(message: AgentMessage | AgentMessage[]): Promise<void> {
    await this.agent.prompt(message);
  }

  async continue(): Promise<void> {
    await this.agent.continue();
  }

  steer(message: AgentMessage): void {
    this.agent.steer(message);
  }

  followUp(message: AgentMessage): void {
    this.agent.followUp(message);
  }

  abort(): void {
    this.agent.abort();
  }

  async waitForIdle(): Promise<void> {
    await this.agent.waitForIdle();
  }

  subscribe(listener: Parameters<Agent["subscribe"]>[0]): () => void {
    return this.agent.subscribe(listener);
  }

  snapshot(): AgentLoopSnapshot {
    return {
      messages: this.agent.state.messages,
      isStreaming: this.agent.state.isStreaming,
      modelId: this.agent.state.model.id
    };
  }
}
