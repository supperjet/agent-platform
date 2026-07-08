import {
  ExecutionDispatcher,
  type CommandRunner,
  type DispatchCommand
} from "../contracts.js";

export type InProcessExecutionDispatcherOptions = {
  maxConcurrency?: number;
  onError?: (error: unknown) => void;
};

export class InProcessExecutionDispatcher extends ExecutionDispatcher {
  private readonly active = new Set<Promise<void>>();
  private readonly activePromptSessions = new Set<string>();
  private readonly pendingPrompts: Array<{ commandId: string; sessionId: string }> = [];
  private readonly maxConcurrency: number;
  private readonly onError: (error: unknown) => void;
  private closing = false;

  constructor(
    private readonly commandRunner: CommandRunner,
    options: InProcessExecutionDispatcherOptions = {}
  ) {
    super();
    this.maxConcurrency = options.maxConcurrency ?? 4;
    if (this.maxConcurrency < 1) throw new Error("maxConcurrency must be at least 1.");
    this.onError = options.onError ?? (() => {});
  }

  async enqueue(command: DispatchCommand) {
    if (this.closing) throw new Error("Execution dispatcher is closing.");

    if (command.type === "prompt") {
      this.pendingPrompts.push({ commandId: command.commandId, sessionId: command.sessionId });
      this.drainPrompts();
      return;
    }
    this.start(command.commandId);
  }

  ready() {
    return Promise.resolve();
  }

  async close() {
    this.closing = true;
    while (this.pendingPrompts.length > 0 || this.active.size > 0) {
      this.drainPrompts();
      if (this.active.size > 0) await Promise.race([...this.active]);
    }
  }

  private drainPrompts() {
    while (this.activePromptSessions.size < this.maxConcurrency) {
      const index = this.pendingPrompts.findIndex(
        (command) => !this.activePromptSessions.has(command.sessionId)
      );
      if (index < 0) return;
      const [command] = this.pendingPrompts.splice(index, 1);
      if (!command) return;
      this.activePromptSessions.add(command.sessionId);
      this.start(command.commandId, command.sessionId);
    }
  }

  private start(commandId: string, promptSessionId?: string) {
    const task = Promise.resolve()
      .then(() => this.commandRunner.executeById(commandId))
      .catch((error) => this.onError(error));
    this.active.add(task);
    void task.finally(() => {
      this.active.delete(task);
      if (promptSessionId) this.activePromptSessions.delete(promptSessionId);
      this.drainPrompts();
    });
  }

}
