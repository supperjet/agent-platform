import {
  CommandSubmissionStore,
  type CommandRecord,
  type CommandRepository,
  type SubmitCommand
} from "../contracts.js";

export class InMemoryCommandSubmissionStore extends CommandSubmissionStore {
  constructor(
    private readonly commandRepository: CommandRepository,
    private readonly now: () => number = Date.now
  ) {
    super();
  }

  createQueuedIfAbsent(command: SubmitCommand) {
    const now = this.now();
    const record: CommandRecord = {
      commandId: command.commandId,
      sessionId: command.sessionId,
      type: command.type,
      ...(command.text === undefined ? {} : { text: command.text }),
      accepted: true,
      status: "queued",
      createdAt: now,
      updatedAt: now
    };
    return this.commandRepository.createIfAbsent(record);
  }
}
