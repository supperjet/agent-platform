import assert from "node:assert/strict";
import test from "node:test";
import { readServerConfig, readWorkerConfig } from "../utils/server-config.js";

test("reads server defaults without requiring infrastructure", () => {
  assert.deepEqual(readServerConfig({}), {
    host: "127.0.0.1",
    port: 3000,
    logLevel: "info",
    storageMode: "inMemory"
  });
});

test("reads explicit server and infrastructure configuration", () => {
  assert.deepEqual(readServerConfig({
    STORAGE_MODE: "dataBase",
    HOST: "0.0.0.0",
    PORT: "3100",
    LOG_LEVEL: "debug",
    MYSQL_URL: "mysql://database",
    REDIS_URL: "redis://queue"
  }), {
    host: "0.0.0.0",
    port: 3100,
    logLevel: "debug",
    storageMode: "dataBase",
    mysqlUrl: "mysql://database",
    redisUrl: "redis://queue"
  });
});

test("ignores database URLs in inMemory mode", () => {
  assert.deepEqual(readServerConfig({
    STORAGE_MODE: "inMemory",
    MYSQL_URL: "mysql://database",
    REDIS_URL: "redis://queue"
  }), {
    host: "127.0.0.1",
    port: 3000,
    logLevel: "info",
    storageMode: "inMemory"
  });
});

test("rejects invalid storage configuration and ports", () => {
  assert.throws(() => readServerConfig({ PORT: "0" }), /PORT must be an integer/);
  assert.throws(
    () => readServerConfig({ STORAGE_MODE: "dataBase" }),
    /STORAGE_MODE=dataBase requires MYSQL_URL/
  );
  assert.throws(
    () => readServerConfig({ STORAGE_MODE: "dataBase", MYSQL_URL: "mysql://database" }),
    /STORAGE_MODE=dataBase requires REDIS_URL/
  );
  assert.throws(() => readServerConfig({ STORAGE_MODE: "database" }), /STORAGE_MODE must be/);
});

test("reads independent Worker infrastructure and concurrency", () => {
  assert.deepEqual(readWorkerConfig({
    MYSQL_URL: "mysql://database",
    REDIS_URL: "redis://queue",
    LOG_LEVEL: "debug",
    WORKER_CONCURRENCY: "8"
  }), {
    mysqlUrl: "mysql://database",
    redisUrl: "redis://queue",
    logLevel: "debug",
    concurrency: 8
  });
});

test("requires shared infrastructure for an independent Worker", () => {
  assert.throws(() => readWorkerConfig({}), /requires MYSQL_URL/);
  assert.throws(
    () => readWorkerConfig({ MYSQL_URL: "mysql://database" }),
    /requires REDIS_URL/
  );
  assert.throws(() => readWorkerConfig({
    MYSQL_URL: "mysql://database",
    REDIS_URL: "redis://queue",
    WORKER_CONCURRENCY: "0"
  }), /WORKER_CONCURRENCY must be a positive integer/);
});
