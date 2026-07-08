import {
  CommandRunner,
  type CommandRecord,
  type CommandRepository,
  type CommandType,
  type ExecutionLogger,
  type SessionManager
} from "./contracts.js";

export type CommandRunnerOptions = {
  now?: () => number;
  runInContext?: (command: CommandRecord, operation: () => Promise<void>) => Promise<void>;
  logger?: ExecutionLogger;
};

export class SessionCommandRunner extends CommandRunner {
  private readonly now: () => number;
  private readonly runInContext: NonNullable<CommandRunnerOptions["runInContext"]>;
  private readonly logger: ExecutionLogger;

  constructor(
    private readonly commandRepository: CommandRepository,
    private readonly sessionManager: SessionManager,
    options: CommandRunnerOptions = {}
  ) {
    super();
    this.now = options.now ?? Date.now;
    this.runInContext = options.runInContext ?? ((_command, operation) => operation());
    this.logger = options.logger ?? NOOP_EXECUTION_LOGGER;
  }

  async executeById(commandId: string) {
    const command = await this.commandRepository.find(commandId);
    if (!command) throw new Error(`Command "${commandId}" was not found.`);
    await this.runInContext(command, () => this.execute(command));
  }

  private async execute(command: CommandRecord) {
    await this.commandRepository.save({ ...command, status: "running", updatedAt: this.now() });
    this.logger.log("info", commandLog(command, "command.execution.started", "running"));
    try {
      const receipt = command.type === "abort"
        ? await this.sessionManager.abort(command.sessionId)
        : await executeTextCommand(
          this.sessionManager,
          command.type,
          command.sessionId,
          command.commandId,
          command.text!
        );
      await this.commandRepository.save({
        ...command,
        accepted: receipt.accepted,
        status: receipt.accepted && receipt.outcome.status === "succeeded" ? "succeeded" : "failed",
        updatedAt: this.now()
      });
      if (receipt.accepted && receipt.outcome.status === "succeeded") {
        this.logger.log("info", commandLog(command, "command.execution.succeeded", "succeeded"));
      } else {
        this.logger.log("error", {
          ...commandLog(command, "command.execution.failed", "failed"),
          ...(receipt.outcome.status === "failed" ? {
            errorCode: receipt.outcome.errorCode,
            errorMessage: receipt.outcome.message
          } : {})
        });
      }
    } catch (error) {
      await this.commandRepository.save({ ...command, status: "failed", updatedAt: this.now() });
      this.logger.log("error", {
        ...commandLog(command, "command.execution.failed", "failed"),
        error
      });
      throw error;
    }
  }
}

const NOOP_EXECUTION_LOGGER: ExecutionLogger = { log() {} };

function commandLog(
  command: CommandRecord,
  event: string,
  status: CommandRecord["status"]
) {
  return {
    event,
    commandId: command.commandId,
    sessionId: command.sessionId,
    commandType: command.type,
    status
  };
}

function executeTextCommand(
  sessions: SessionManager,
  type: Exclude<CommandType, "abort">,
  sessionId: string,
  commandId: string,
  text: string
) {
  if (type === "prompt") return sessions.prompt(sessionId, text, commandId);
  if (type === "steer") return sessions.steer(sessionId, text);
  return sessions.followUp(sessionId, text);
}
