import { PiAgentRuntimeFactory } from "@agent-platform/agent-core";
import type { ApplicationRuntime } from "./bootstrap.js";
import { SessionCommandRunner } from "./session/command-runner.js";
import type { ExecutionLogger } from "./session/contracts.js";
import { MySqlCommandRepository } from "./session/mysql/mysql-command-repository.js";
import { MySqlSessionStore } from "./session/mysql/mysql-session-store.js";
import { StoredSessionManager } from "./session/mysql/stored-session-manager.js";
import { BullMqCommandWorker } from "./session/redis/bullmq-command-worker.js";
import { RedisCommandEventStream } from "./session/redis/redis-command-event-stream.js";
import { connectCommandDatabase } from "./utils/command-database.js";

export type WorkerOptions = {
  mysqlUrl: string;
  redisUrl: string;
  concurrency?: number;
  runtime: ApplicationRuntime;
  executionLogger?: ExecutionLogger;
  reportAssembly?: (message: string) => void;
};

/** Worker composition root: consumes queued commands, restores Sessions, and executes Agent Core. */
export async function createWorker(options: WorkerOptions) {
  const report = options.reportAssembly ?? (() => {});
  const loggerOptions = options.executionLogger ? { logger: options.executionLogger } : {};
  const pool = await connectCommandDatabase(options.mysqlUrl);
  if (!pool) throw new Error("Agent Worker could not create the MySQL pool.");
  report("Worker MySQL 连接成功");

  const commandEvents = new RedisCommandEventStream({
    redisUrl: options.redisUrl,
    ...loggerOptions
  });

  // 创建Agent RuntimeFactory
  const runtimeFactory = new PiAgentRuntimeFactory({
    model: options.runtime.model,
    resolveApiKey: options.runtime.resolveApiKey,
    onEvent: (event) => commandEvents.accept(event),
    ...(options.runtime.onApiKeyResolved
      ? { onApiKeyResolved: options.runtime.onApiKeyResolved }
      : {})
  });

  // 创建命令仓库
  const commandRepository = new MySqlCommandRepository(pool);

  // 创建会话管理器
  const sessionManager = new StoredSessionManager(runtimeFactory, new MySqlSessionStore(pool));

  // 创建命令执行器
  const commandRunner = new SessionCommandRunner(commandRepository, sessionManager, {
    ...loggerOptions,
    runInContext: (command, operation) => commandEvents.run(
      command.sessionId,
      command.commandId,
      operation
    )
  });

  // 创建命令工作器
  const commandWorker = new BullMqCommandWorker(commandRunner, {
    redisUrl: options.redisUrl,
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
    ...loggerOptions
  });

  report("Worker CommandRunner 与 Agent RuntimeFactory 装配成功");

  let closePromise: Promise<void> | undefined;
  return {
    commandWorker,
    commandRunner,
    sessionManager,
    commandRepository,
    commandEvents,
    ready: () => Promise.all([commandWorker.ready(), commandEvents.ready()]).then(() => {}),
    close() {
      closePromise ??= commandWorker.close()
        .then(() => commandEvents.close())
        .then(() => pool.end());
      return closePromise;
    }
  };
}
