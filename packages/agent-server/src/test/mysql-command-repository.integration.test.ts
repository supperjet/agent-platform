import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createPool } from "mysql2/promise";
import type { CommandRecord } from "../session/contracts.js";
import { MySqlCommandRepository } from "../session/mysql/mysql-command-repository.js";

const mysqlUrl = process.env.MYSQL_INTEGRATION_URL;

test("persists commands across MySQL pool restarts", {
  skip: mysqlUrl ? false : "MYSQL_INTEGRATION_URL is not configured."
}, async () => {
  const commandId = `integration-${randomUUID()}`;
  const command: CommandRecord = {
    commandId,
    sessionId: "integration-session",
    type: "prompt",
    text: "你好，MySQL",
    accepted: true,
    status: "queued",
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  const firstPool = createPool({ uri: mysqlUrl!, connectionLimit: 2 });
  try {
    const firstRepository = new MySqlCommandRepository(firstPool);
    const creation = await firstRepository.createIfAbsent(command);
    assert.equal(creation.created, true);
  } finally {
    await firstPool.end();
  }

  const secondPool = createPool({ uri: mysqlUrl!, connectionLimit: 2 });
  try {
    const secondRepository = new MySqlCommandRepository(secondPool);
    assert.deepEqual(await secondRepository.find(commandId), command);

    const duplicate = await secondRepository.createIfAbsent(command);
    assert.equal(duplicate.created, false);
    assert.deepEqual(duplicate.command, command);

    const succeeded = { ...command, status: "succeeded" as const, updatedAt: command.updatedAt + 1 };
    await secondRepository.save(succeeded);
    assert.deepEqual(await secondRepository.find(commandId), succeeded);
  } finally {
    await secondPool.execute("DELETE FROM commands WHERE command_id = ?", [commandId]);
    await secondPool.end();
  }
});
