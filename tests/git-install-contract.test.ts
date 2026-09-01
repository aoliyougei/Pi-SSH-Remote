import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const root = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("Git repository installs only the SSH Remote Pi entry", () => {
  assert.deepEqual(root.pi?.extensions, ["./extensions/ssh-remote/index.ts"]);
  assert.equal(root.workspaces.includes("extensions/shell-adapter-fixture"), false);
  assert.equal(existsSync(new URL("../extensions/shell-adapter-fixture", import.meta.url)), false);
});
