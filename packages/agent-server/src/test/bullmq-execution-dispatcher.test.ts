import assert from "node:assert/strict";
import test from "node:test";
import { redisOptionsFromUrl } from "../session/redis/bullmq-execution-dispatcher.js";

test("parses authenticated Redis URLs", () => {
  assert.deepEqual(
    redisOptionsFromUrl("rediss://user:p%40ss@redis.example.com:6380/2"),
    {
      host: "redis.example.com",
      port: 6380,
      db: 2,
      username: "user",
      password: "p@ss",
      tls: {}
    }
  );
});

test("rejects unsupported Redis URL protocols and invalid databases", () => {
  assert.throws(
    () => redisOptionsFromUrl("http://127.0.0.1:6380"),
    /redis: or rediss:/
  );
  assert.throws(
    () => redisOptionsFromUrl("redis://127.0.0.1:6380/not-a-database"),
    /non-negative integer/
  );
});
