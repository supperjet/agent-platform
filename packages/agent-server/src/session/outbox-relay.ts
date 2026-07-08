import type {
  CommandRepository,
  ExecutionDispatcher,
  ExecutionLogger,
  OutboxClaim,
  OutboxStore
} from "./contracts.js";

export type OutboxRelayOptions = {
  pollIntervalMs?: number;
  leaseDurationMs?: number;
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
  batchSize?: number;
  now?: () => number;
  onError?: (error: unknown) => void;
  logger?: ExecutionLogger;
};

export class OutboxRelay {
  private readonly pollIntervalMs: number;
  private readonly leaseDurationMs: number;
  private readonly retryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly batchSize: number;
  private readonly now: () => number;
  private readonly onError: (error: unknown) => void;
  private readonly logger: ExecutionLogger;
  private timer: NodeJS.Timeout | undefined;
  private activePoll: Promise<void> | undefined;
  private wakeRequested = false;
  private closing = false;

  constructor(
    private readonly outboxStore: OutboxStore,
    private readonly commandRepository: CommandRepository,
    private readonly executionDispatcher: ExecutionDispatcher,
    options: OutboxRelayOptions = {}
  ) {
    this.pollIntervalMs = positive(options.pollIntervalMs ?? 500, "pollIntervalMs");
    this.leaseDurationMs = positive(options.leaseDurationMs ?? 30_000, "leaseDurationMs");
    this.retryDelayMs = positive(options.retryDelayMs ?? 1_000, "retryDelayMs");
    this.maxRetryDelayMs = positive(options.maxRetryDelayMs ?? 60_000, "maxRetryDelayMs");
    this.batchSize = positive(options.batchSize ?? 20, "batchSize");
    this.now = options.now ?? Date.now;
    this.onError = options.onError ?? (() => {});
    this.logger = options.logger ?? { log() {} };
  }

  start() {
    this.schedule(0);
  }

  wake() {
    if (this.closing) return;
    if (this.activePoll) {
      this.wakeRequested = true;
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.schedule(0);
  }

  async close() {
    this.closing = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.activePoll;
  }

  private schedule(delayMs: number) {
    if (this.closing || this.timer || this.activePoll) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.activePoll = this.poll().finally(() => {
        this.activePoll = undefined;
        if (this.closing) return;
        const delay = this.wakeRequested ? 0 : this.pollIntervalMs;
        this.wakeRequested = false;
        this.schedule(delay);
      });
    }, delayMs);
    this.timer.unref();
  }

  private async poll() {
    try {
      for (let delivered = 0; delivered < this.batchSize; delivered += 1) {
        const claim = await this.outboxStore.claimNext(this.now(), this.leaseDurationMs);
        if (!claim) return;
        await this.deliver(claim);
      }
      this.wakeRequested = true;
    } catch (error) {
      this.onError(error);
    }
  }

  private async deliver(claim: OutboxClaim) {
    try {
      const command = await this.commandRepository.find(claim.commandId);
      if (!command) throw new Error(`Outbox command "${claim.commandId}" was not found.`);
      if (command.status === "queued") {
        await this.executionDispatcher.enqueue(command);
      }
      await this.outboxStore.markPublished(claim, this.now());
      this.logger.log("info", {
        event: "outbox.command.published",
        commandId: command.commandId,
        sessionId: command.sessionId,
        commandType: command.type,
        attempt: claim.attempts
      });
    } catch (error) {
      const availableAt = this.now() + retryDelay(
        claim.attempts,
        this.retryDelayMs,
        this.maxRetryDelayMs
      );
      await this.outboxStore.reschedule(claim, errorMessage(error), availableAt);
      this.logger.log("error", {
        event: "outbox.command.delivery_failed",
        commandId: claim.commandId,
        attempt: claim.attempts,
        error
      });
      this.onError(error);
    }
  }
}

function retryDelay(attempts: number, initial: number, maximum: number) {
  return Math.min(initial * 2 ** Math.max(0, attempts - 1), maximum);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function positive(value: number, name: string) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  return value;
}
