import assert from "node:assert/strict";
import test from "node:test";
import { isDestructiveRemoteCommand } from "../extensions/ssh-remote/src/exec/policy.ts";

test("destructive policy inspects chained commands", () => {
  assert.equal(isDestructiveRemoteCommand("echo ok && rm -rf /"), true);
  assert.equal(isDestructiveRemoteCommand("npm test"), false);
  assert.equal(isDestructiveRemoteCommand("journalctl -u example-api"), false);
});

test("workspace and mirror tool names remain semantically distinct", async () => {
  const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../extensions/ssh-remote/src/exec/tools.ts", import.meta.url), "utf8"));
  assert.match(source, /name: "ssh_exec"/);
  assert.match(source, /does not switch the workspace/);
  assert.match(source, /name: "ssh_sync"/);
  assert.match(source, /full SSH workspace/);
  assert.doesNotMatch(source, /name: "ssh_connect"/);
  const controller = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../extensions/ssh-remote/src/exec/controller.ts", import.meta.url), "utf8"));
  assert.match(controller, /adapter\.runShell/);
  assert.match(controller, /Specify server explicitly.*full SSH workspace/);
  assert.doesNotMatch(controller, /client\.run\(command/);
});
