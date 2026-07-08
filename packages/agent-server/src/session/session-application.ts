import {
  SessionApplication,
  type CommandRecord,
  type CommandRepository,
  type CommandSubmissionStore,
  type ExecutionDispatcher,
  type SessionQuery,
  type SessionView,
  type SubmitCommand,
  type SubmittedCommand
} from "./contracts.js";
import { CommandConflictError, InvalidCommandError } from "./errors.js";

export class InProcessSessionApplication extends SessionApplication {
  private closePromise?: Promise<void>;

  constructor(
    private readonly sessionQuery: SessionQuery,
    private readonly commandRepository: CommandRepository,
    private readonly commandSubmissionStore: CommandSubmissionStore,
    private readonly executionDispatcher: ExecutionDispatcher,
    private readonly afterCommandCreated: (command: CommandRecord) => Promise<void> =
      (command) => executionDispatcher.enqueue(command),
    private readonly beforeClose: () => Promise<void> = () => Promise.resolve(),
    private readonly closeRepository: () => Promise<void> = () => Promise.resolve()
  ) {
    super();
  }

  async submitCommand(command: SubmitCommand): Promise<SubmittedCommand> {
    if (command.type !== "abort" && command.text === undefined) {
      throw new InvalidCommandError(`Command type "${command.type}" requires text.`);
    }

    const creation = await this.commandSubmissionStore.createQueuedIfAbsent(command);
    if (!creation.created) {
      if (!matchesCommand(creation.command, command)) {
        throw new CommandConflictError(`Command "${command.commandId}" already exists with different content.`);
      }
      return {
        accepted: creation.command.accepted ?? true,
        sessionId: creation.command.sessionId,
        commandId: creation.command.commandId,
        type: creation.command.type
      };
    }
    await this.afterCommandCreated(creation.command);
    return {
      accepted: true,
      sessionId: command.sessionId,
      commandId: command.commandId,
      type: command.type
    };
  }

  async getSession(sessionId: string): Promise<SessionView | undefined> {
    const snapshot = await this.sessionQuery.snapshot(sessionId);
    return snapshot ? {
      sessionId: snapshot.sessionId,
      status: snapshot.status === "running" ? "running" : "idle",
      createdAt: new Date(snapshot.createdAt).toISOString(),
      lastActiveAt: new Date(snapshot.lastActiveAt).toISOString(),
      messageCount: snapshot.messageCount,
      modelId: snapshot.modelId
    } : undefined;
  }

  getCommand(commandId: string) {
    return this.commandRepository.find(commandId);
  }

  close() {
    this.closePromise ??= this.closeDependencies();
    return this.closePromise;
  }

  private async closeDependencies() {
    await this.beforeClose();
    await this.executionDispatcher.close();
    await this.closeRepository();
  }
}

function matchesCommand(existing: CommandRecord, submitted: SubmitCommand) {
  return existing.sessionId === submitted.sessionId
    && existing.type === submitted.type
    && existing.text === submitted.text;
}
