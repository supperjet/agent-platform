const DEFAULT_PORT = 3000;
const DEFAULT_HOST = "127.0.0.1";

export type StorageMode = "inMemory" | "dataBase";

type CommonServerConfig = {
  host: string;
  port: number;
  logLevel: string;
};

export type ServerConfig = CommonServerConfig & (
  | { storageMode: "inMemory" }
  | { storageMode: "dataBase"; mysqlUrl: string; redisUrl: string }
);

export type WorkerConfig = {
  mysqlUrl: string;
  redisUrl: string;
  logLevel: string;
  concurrency: number;
};

/** Reads and validates process-level configuration before adapters are created. */
export function readServerConfig(environment: NodeJS.ProcessEnv = process.env): ServerConfig {
  const storageMode = readStorageMode(environment.STORAGE_MODE);
  const mysqlUrl = environment.MYSQL_URL;
  const redisUrl = environment.REDIS_URL;
  const common = {
    host: environment.HOST ?? DEFAULT_HOST,
    port: readPort(environment.PORT),
    logLevel: environment.LOG_LEVEL ?? "info"
  };
  if (storageMode === "inMemory") return { ...common, storageMode };
  if (!mysqlUrl) throw new Error("STORAGE_MODE=dataBase requires MYSQL_URL.");
  if (!redisUrl) throw new Error("STORAGE_MODE=dataBase requires REDIS_URL.");
  return { ...common, storageMode, mysqlUrl, redisUrl };
}

/** Worker always uses shared MySQL and Redis; it has no in-memory production mode. */
export function readWorkerConfig(environment: NodeJS.ProcessEnv = process.env): WorkerConfig {
  if (!environment.MYSQL_URL) throw new Error("Agent Worker requires MYSQL_URL.");
  if (!environment.REDIS_URL) throw new Error("Agent Worker requires REDIS_URL.");
  return {
    mysqlUrl: environment.MYSQL_URL,
    redisUrl: environment.REDIS_URL,
    logLevel: environment.LOG_LEVEL ?? "info",
    concurrency: readPositiveInteger(environment.WORKER_CONCURRENCY, 4, "WORKER_CONCURRENCY")
  };
}

function readStorageMode(value: string | undefined): StorageMode {
  if (!value || value === "inMemory") return "inMemory";
  if (value === "dataBase") return "dataBase";
  throw new Error('STORAGE_MODE must be either "inMemory" or "dataBase".');
}

function readPort(value: string | undefined) {
  if (!value) return DEFAULT_PORT;

  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }
  return port;
}

function readPositiveInteger(value: string | undefined, defaultValue: number, name: string) {
  if (!value) return defaultValue;
  const result = Number(value);
  if (!Number.isInteger(result) || result < 1) throw new Error(`${name} must be a positive integer.`);
  return result;
}
