import { config } from "dotenv";
import { createWorker } from "./bootstrap-worker.js";
import { createPinoExecutionLogger, createServerLogger } from "./observability/pino-execution-logger.js";
import { readWorkerConfig } from "./utils/server-config.js";
import { registerShutdownHandlers } from "./utils/shutdown.js";
import { logStartupSuccess } from "./utils/startup-console.js";

config({ path: new URL("../../../.env", import.meta.url) });

await main();

async function main() {
  const env = readWorkerConfig();
  const logger = createServerLogger({
    level: env.logLevel,
    service: "agent-worker"
  });
  const worker = await createWorker({
    mysqlUrl: env.mysqlUrl,
    redisUrl: env.redisUrl,
    concurrency: env.concurrency,
    executionLogger: createPinoExecutionLogger(logger),
    reportAssembly: logStartupSuccess
  });

  try {
    await worker.ready();
  } catch (error) {
    await worker.close();
    throw error;
  }
  registerShutdownHandlers(() => worker.close());
  logStartupSuccess(`Agent Worker 启动成功（concurrency=${env.concurrency}）`);
  logger.info({
    concurrency: env.concurrency
  }, "Agent worker started");
}
