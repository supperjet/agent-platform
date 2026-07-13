import {
  AgentRuntime,
  type AgentConversationState,
  type AgentExecutionOutcome,
  type AgentRuntimeCommand,
  type AgentRuntimeEventListener
} from "../contracts.js";
import type { ConversationRuntimeState } from "../conversation/conversation-store.js";
import type { AgentLoop } from "./agent-loop.js";
import { EventHub } from "./event-hub.js";
import { StateExporter } from "./state-exporter.js";
import { TurnRunner } from "./turn-runner.js";

export class AgentRuntimeSession extends AgentRuntime {
  private readonly eventHub: EventHub;
  private readonly stateExporter: StateExporter;
  private readonly turnRunner: TurnRunner;

  constructor(
    private readonly sessionId: string,
    private readonly loop: AgentLoop,
    conversation: ConversationRuntimeState,
    initialMessageSequence = 0
  ) {
    super();
    this.eventHub = new EventHub({ sessionId, initialMessageSequence });
    this.stateExporter = new StateExporter({ sessionId, conversation });
    this.loop.subscribe((event) => this.eventHub.publishAgentEvent(event));
    this.turnRunner = new TurnRunner({
      loop: this.loop,
      readExecutionOutcome: () => this.eventHub.readExecutionOutcome(),
      afterTurn: () => this.stateExporter.syncFromSnapshot(this.loop.snapshot())
    });
  }

  async execute(command: AgentRuntimeCommand): Promise<AgentExecutionOutcome> {
    return this.turnRunner.run(command);
  }

  snapshot() {
    const snapshot = this.loop.snapshot();
    return {
      messageCount: snapshot.messages.length,
      transcriptRoles: snapshot.messages.map((message) => message.role),
      isRunning: snapshot.isStreaming,
      modelId: snapshot.modelId
    };
  }

  exportState(): AgentConversationState {
    return this.stateExporter.exportState(this.loop.snapshot());
  }

  subscribe(listener: AgentRuntimeEventListener) {
    return this.eventHub.subscribe(listener);
  }
}
