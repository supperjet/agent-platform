import type { FastifyServerOptions } from "fastify";
import type { ExecutionLogger } from "./session/contracts.js";
import { PiAgentRuntimeFactory, type AgentModel } from "@agent-platform/agent-core";
import { DefaultBrowserEventProjector } from "./consumer/browser-events.js";
import { createAgentFastifyServer } from "./consumer/fastify-app.js";
import { InMemoryPublicEventStream } from "./consumer/public-event-stream.js";
import { RedisPublicEventStream } from "./consumer/redis-public-event-stream.js";
import { SessionCommandRunner } from "./session/command-runner.js";
import { InMemoryCommandRepository } from "./session/memory/in-memory-command-repository.js";
import { InMemoryCommandSubmissionStore } from "./session/memory/in-memory-command-submission-store.js";
import { InMemorySessionManager } from "./session/memory/in-memory-session-manager.js";
import { InProcessExecutionDispatcher } from "./session/memory/in-process-execution-dispatcher.js";
import { MySqlCommandRepository } from "./session/mysql/mysql-command-repository.js";
import { MySqlCommandSubmissionStore } from "./session/mysql/mysql-command-submission-store.js";
import { MySqlOutboxStore } from "./session/mysql/mysql-outbox-store.js";
import { MySqlSessionStore } from "./session/mysql/mysql-session-store.js";
import { StoredSessionQuery } from "./session/mysql/stored-session-query.js";
import { OutboxRelay } from "./session/outbox-relay.js";
import { BullMqExecutionDispatcher } from "./session/redis/bullmq-execution-dispatcher.js";
import { InProcessSessionApplication } from "./session/session-application.js";
import { connectCommandDatabase } from "./utils/command-database.js";

export type ApplicationRuntime = {
  model: AgentModel;
  resolveApiKey: (provider: string) => string | undefined | Promise<string | undefined>;
  onApiKeyResolved?: () => void;
};

type CommonApplicationOptions = {
  fastify?: FastifyServerOptions;
  reportAssembly?: (message: string) => void;
  executionLogger?: ExecutionLogger;
};

type InMemoryApplicationOptions = CommonApplicationOptions & {
  storageMode: "inMemory";
  runtime: ApplicationRuntime;
};

type StoreApplicationOptions = CommonApplicationOptions & {
  storageMode: "dataBase";
  mysqlUrl: string;
  redisUrl: string;
};

export type ApplicationOptions = InMemoryApplicationOptions | StoreApplicationOptions;

/** Server composition root. Database mode only produces jobs; Agent execution belongs to start-worker. */
export async function createApplication(options: ApplicationOptions) {
  return options.storageMode === "dataBase"
    ? createStoreApplication(options)
    : createMemoryApplication(options);
}

async function createMemoryApplication(options: InMemoryApplicationOptions) {
  const report = options.reportAssembly ?? (() => {});
  const loggerOptions = options.executionLogger ? { logger: options.executionLogger } : {};
  const browserEvents = new DefaultBrowserEventProjector();
  const publicEvents = new InMemoryPublicEventStream(browserEvents);
  report("PublicEventStream 装配成功（inMemory）");
  const runtimeFactory = new PiAgentRuntimeFactory({
    model: options.runtime.model,
    resolveApiKey: options.runtime.resolveApiKey,
    onEvent: (event) => publicEvents.accept(event),
    ...(options.runtime.onApiKeyResolved
      ? { onApiKeyResolved: options.runtime.onApiKeyResolved }
      : {})
  });
  report("Agent RuntimeFactory 装配成功");

  const sessionManager = new InMemorySessionManager(runtimeFactory);
  const commandRepository = new InMemoryCommandRepository();
  const commandSubmissionStore = new InMemoryCommandSubmissionStore(commandRepository);
  const commandRunner = new SessionCommandRunner(commandRepository, sessionManager, {
    ...loggerOptions,
    runInContext: (command, operation) => publicEvents.run(
      command.sessionId,
      command.commandId,
      operation
    )
  });
  const executionDispatcher = new InProcessExecutionDispatcher(commandRunner);
  const sessionApplication = new InProcessSessionApplication(
    sessionManager,
    commandRepository,
    commandSubmissionStore,
    executionDispatcher
  );

  report("SessionManager 装配成功（inMemory）");
  report("CommandRunner 装配成功");
  report("ExecutionDispatcher 装配成功（InProcessExecutionDispatcher）");
  const app = createAgentFastifyServer({ application: sessionApplication, publicEvents }, options.fastify);
  report("Fastify HTTP/SSE Adapter 装配成功");
  return {
    app,
    sessionApplication,
    sessionManager,
    commandRepository,
    commandSubmissionStore,
    commandRunner,
    executionDispatcher,
    outboxRelay: undefined,
    publicEvents,
    browserEvents
  };
}

async function createStoreApplication(options: StoreApplicationOptions) {
  const report = options.reportAssembly ?? (() => {});
  const loggerOptions = options.executionLogger ? { logger: options.executionLogger } : {};
  const pool = await connectCommandDatabase(options.mysqlUrl);
  if (!pool) throw new Error("Database storage was selected but the MySQL pool was not created.");
  report("MySQL 连接成功，commands/outbox_events/sessions 表检查通过");

  const commandRepository = new MySqlCommandRepository(pool);
  const commandSubmissionStore = new MySqlCommandSubmissionStore(pool);
  const sessionManager = new StoredSessionQuery(new MySqlSessionStore(pool));
  const executionDispatcher = new BullMqExecutionDispatcher({
    redisUrl: options.redisUrl,
    ...loggerOptions
  });
  const outboxRelay = new OutboxRelay(
    new MySqlOutboxStore(pool),
    commandRepository,
    executionDispatcher,
    loggerOptions
  );
  const browserEvents = new DefaultBrowserEventProjector();
  const publicEvents = new RedisPublicEventStream(browserEvents, {
    redisUrl: options.redisUrl,
    ...loggerOptions
  });
  const sessionApplication = new InProcessSessionApplication(
    sessionManager,
    commandRepository,
    commandSubmissionStore,
    executionDispatcher,
    async () => outboxRelay.wake(),
    async () => {
      await outboxRelay.close();
      await publicEvents.close();
    },
    () => pool.end()
  );

  try {
    outboxRelay.start();
    report("Outbox Relay 启动成功");
    report("SessionQuery 装配成功（MySQL）");
    report("ExecutionDispatcher 装配成功（BullMqExecutionDispatcher Queue Producer）");
    const app = createAgentFastifyServer({ application: sessionApplication, publicEvents }, options.fastify);
    report("Fastify HTTP/SSE Adapter 装配成功");
    return {
      app,
      sessionApplication,
      sessionManager,
      commandRepository,
      commandSubmissionStore,
      commandRunner: undefined,
      executionDispatcher,
      outboxRelay,
      publicEvents,
      browserEvents
    };
  } catch (error) {
    await outboxRelay.close();
    await publicEvents.close();
    await executionDispatcher.close();
    await pool.end();
    throw error;
  }
}
