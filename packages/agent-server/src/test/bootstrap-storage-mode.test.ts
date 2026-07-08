import assert from "node:assert/strict";
import test from "node:test";
import { registerFauxProvider } from "@earendil-works/pi-ai";
import { createApplication } from "../bootstrap.js";

const mysqlUrl = process.env.MYSQL_INTEGRATION_URL;

test("createApplication delegates inMemory assembly behind one interface", async () => {
  const registration = registerFauxProvider();
  const reports: string[] = [];
  const application = await createApplication({
    storageMode: "inMemory",
    runtime: { model: registration.getModel(), resolveApiKey: () => "test-key" },
    reportAssembly: (message) => reports.push(message)
  });

  try {
    assert.equal(application.sessionManager.constructor.name, "InMemorySessionManager");
    assert.equal(application.commandRepository.constructor.name, "InMemoryCommandRepository");
    assert.equal(application.outboxRelay, undefined);
    assert.equal(reports.includes("SessionManager 装配成功（inMemory）"), true);
  } finally {
    await application.app.close();
    registration.unregister();
  }
});

test("createApplication initializes and assembles dataBase storage internally", {
  skip: mysqlUrl ? false : "MYSQL_INTEGRATION_URL is not configured."
}, async () => {
  const reports: string[] = [];
  const application = await createApplication({
    storageMode: "dataBase",
    mysqlUrl: mysqlUrl!,
    redisUrl: process.env.REDIS_INTEGRATION_URL ?? "redis://127.0.0.1:6380",
    reportAssembly: (message) => reports.push(message)
  });

  try {
    assert.equal(application.sessionManager.constructor.name, "StoredSessionQuery");
    assert.equal(application.commandRepository.constructor.name, "MySqlCommandRepository");
    assert.notEqual(application.outboxRelay, undefined);
    assert.equal(reports.includes("SessionQuery 装配成功（MySQL）"), true);
    assert.equal(application.commandRunner, undefined);
  } finally {
    await application.app.close();
  }
});
