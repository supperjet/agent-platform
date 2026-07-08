import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "mysql2/promise";
import type { CommandRecord } from "../session/contracts.js";
import { MySqlCommandRepository } from "../session/mysql/mysql-command-repository.js";

const command: CommandRecord = {
  commandId: "command-1",
  sessionId: "session-1",
  type: "prompt",
  text: "hello",
  accepted: true,
  status: "accepted",
  createdAt: 1_000,
  updatedAt: 1_001
};

test("creates a command with version-compatible columns", async () => {
  const calls: QueryCall[] = [];
  const repository = new MySqlCommandRepository(fakePool(calls, [result(1)]));

  const creation = await repository.createIfAbsent(command);

  assert.deepEqual(creation, { created: true, command });
  assert.match(calls[0]?.sql ?? "", /INSERT INTO commands/);
  assert.deepEqual(calls[0]?.values, [
    "command-1", "session-1", "prompt", "hello", 1, "accepted", 1_000, 1_001
  ]);
});

test("returns the stored command when commandId already exists", async () => {
  const calls: QueryCall[] = [];
  const repository = new MySqlCommandRepository(fakePool(calls, [
    duplicateEntry(),
    [[{
      command_id: "command-1",
      session_id: "session-1",
      command_type: "prompt",
      command_text: "stored text",
      accepted: 1,
      status: "queued",
      created_at_ms: 1_000,
      updated_at_ms: 1_002
    }], []]
  ]));

  const creation = await repository.createIfAbsent(command);

  assert.equal(creation.created, false);
  assert.equal(creation.command.text, "stored text");
  assert.equal(creation.command.status, "queued");
});

test("updates an existing command", async () => {
  const calls: QueryCall[] = [];
  const repository = new MySqlCommandRepository(fakePool(calls, [result(1)]));

  await repository.save({ ...command, status: "running", updatedAt: 2_000 });

  assert.match(calls[0]?.sql ?? "", /UPDATE commands SET/);
  assert.deepEqual(calls[0]?.values, [
    "session-1", "prompt", "hello", 1, "running", 1_000, 2_000, "command-1"
  ]);
});

test("returns undefined when a command does not exist", async () => {
  const repository = new MySqlCommandRepository(fakePool([], [[[], []]]));

  assert.equal(await repository.find("missing"), undefined);
});

test("does not hide database errors that are not duplicate entries", async () => {
  const unavailable = Object.assign(new Error("Database unavailable"), { code: "ECONNREFUSED" });
  const repository = new MySqlCommandRepository(fakePool([], [unavailable]));

  await assert.rejects(repository.createIfAbsent(command), unavailable);
});

type QueryCall = { sql: string; values: readonly unknown[] };

function result(affectedRows: number) {
  return [{ affectedRows }, []];
}

function duplicateEntry() {
  return Object.assign(new Error("Duplicate entry"), { code: "ER_DUP_ENTRY" });
}

function fakePool(calls: QueryCall[], responses: unknown[]): Pool {
  return {
    async execute(sql: string, values: readonly unknown[] = []) {
      calls.push({ sql, values });
      const response = responses.shift();
      if (!response) throw new Error("Unexpected query.");
      if (response instanceof Error) throw response;
      return response;
    }
  } as unknown as Pool;
}
