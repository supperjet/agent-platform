import { config } from "dotenv";
import { createDeepSeekRuntime, summarizeModel } from "./runtime/deepseek.js";
import { createApplication } from "./bootstrap.js";
import {
  createPinoExecutionLogger,
  createServerLogger
} from "./observability/pino-execution-logger.js";
import { readServerConfig } from "./utils/server-config.js";
import { registerShutdownHandlers } from "./utils/shutdown.js";
import {
  logServerListening,
  logStartupSuccess,
  logStartupWarning
} from "./utils/startup-console.js";

config({ path: new URL("../../../.env", import.meta.url) });

await main();

async function main() {
  // 读取环境变量
  const env = readServerConfig();
  if (env.storageMode === "inMemory") {
    logStartupWarning("STORAGE_MODE=inMemory，使用内存 Adapter");
  }

  const runtime = env.storageMode === "inMemory" ? createDeepSeekRuntime() : undefined;
  if (runtime) logStartupSuccess(`模型配置加载成功（${runtime.model.provider}/${runtime.model.id}）`);
  const logger = createServerLogger({
    level: env.logLevel,
    ...(runtime ? { modelProvider: runtime.model.provider, modelId: runtime.model.id } : {})
  });
  const executionLogger = createPinoExecutionLogger(logger);

  // The process entry selects infrastructure; bootstrap wires the application graph.
  const application = await createApplication(env.storageMode === "dataBase" ? {
    storageMode: "dataBase" as const,
    mysqlUrl: env.mysqlUrl,
    redisUrl: env.redisUrl,
    executionLogger,
    reportAssembly: logStartupSuccess,
    fastify: { loggerInstance: logger }
  } : {
    storageMode: "inMemory" as const,
    runtime: runtime!,
    executionLogger,
    reportAssembly: logStartupSuccess,
    fastify: { loggerInstance: logger }
  });
  const { app, executionDispatcher, publicEvents } = application;

  try {
    await Promise.all([
      executionDispatcher.ready(),
      publicEvents.ready()
    ]);
    if (env.storageMode === "dataBase") {
      logStartupSuccess("Redis Public Event Stream 已就绪");
    }
  } catch (error) {
    await app.close();
    throw error;
  }

  registerShutdownHandlers(() => app.close());
  await app.listen({ port: env.port, host: env.host });
  logServerListening(`Agent Server 启动成功：http://${env.host}:${env.port}`);

  app.log.info({
    host: env.host,
    port: env.port,
    ...(runtime ? { model: summarizeModel(runtime.model) } : {}),
    storageMode: env.storageMode
  }, "Agent server started");
}
