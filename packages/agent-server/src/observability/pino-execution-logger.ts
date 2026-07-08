import type { Logger } from "pino";
import pino from "pino";
import type { ExecutionLogger } from "../session/contracts.js";

export type ServerLoggerOptions = {
  level: string;
  service?: "agent-server" | "agent-worker";
  modelProvider?: string;
  modelId?: string;
};

export function createServerLogger(options: ServerLoggerOptions) {
  return pino({
    level: options.level,
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "authorization",
        "apiKey",
        "password",
        "redisUrl",
        "mysqlUrl"
      ],
      censor: "[Redacted]"
    }
  }).child({
    service: options.service ?? "agent-server",
    ...(options.modelProvider ? { modelProvider: options.modelProvider } : {}),
    ...(options.modelId ? { modelId: options.modelId } : {})
  });
}

export function createPinoExecutionLogger(logger: Logger): ExecutionLogger {
  return {
    log(level, entry) {
      const { event, error, ...context } = entry;
      logger[level](error === undefined ? context : { ...context, err: error }, event);
    }
  };
}
