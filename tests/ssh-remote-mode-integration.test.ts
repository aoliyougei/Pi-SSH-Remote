import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("mirror and full SSH statuses use distinct keys", async () => {
  const source = await readFile(new URL("../extensions/ssh-remote/src/extension.ts", import.meta.url), "utf8");
  assert.match(source, /setStatus\("ssh-remote-mirror"/);
  assert.match(source, /const STATUS_KEY = "ssh-remote"/);
  assert.doesNotMatch(source, /const STATUS_KEY = "ssh-remote-mirror"/);
});

test("local mirror context explicitly preserves local file tools", async () => {
  const source = await readFile(new URL("../extensions/ssh-remote/src/extension.ts", import.meta.url), "utf8");
  assert.match(source, /Local development workspace context \(authoritative\)/);
  assert.match(source, /file and search tools operate on the local project/);
  assert.match(source, /Proactively use ssh_exec/);
  assert.match(source, /Do not use ssh_connect unless the user explicitly asks/);
});

test("independent connection pool never calls full workspace failure handlers", async () => {
  const source = await readFile(new URL("../extensions/ssh-remote/src/servers/connection-pool.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /markConnectionLost|SSH_ENVIRONMENT_EVENT|runtime\s*=/);
});
