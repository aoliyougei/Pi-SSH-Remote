import assert from "node:assert/strict";
import test from "node:test";
import { MirrorExclusions } from "../extensions/ssh-remote/src/sync/exclusions.ts";
import { buildSyncPlan } from "../extensions/ssh-remote/src/sync/synchronizer.ts";
import type { LocalMirrorManifest, RemoteMirrorEntry } from "../extensions/ssh-remote/src/sync/types.ts";

function manifest(files: Record<string, { size: number; hash?: string }>): LocalMirrorManifest {
  const entries = new Map();
  for (const [path, value] of Object.entries(files)) {
    entries.set(path, { type: "file", relativePath: path, absolutePath: `/local/workspace/${path}`, size: value.size, sha256: value.hash ?? "hash", executable: false });
  }
  return { version: 1, mode: "git", projectRoot: "/local/workspace", generatedAt: "2026-01-01T00:00:00.000Z", entries, totalBytes: 0 };
}

const exclusions = new MirrorExclusions([], [".pi-ssh-sync.json", ".env", "logs/**"]);

test("strict plan uploads size changes, deletes extras, and preserves protected paths", () => {
  const remote: RemoteMirrorEntry[] = [
    { type: "file", relativePath: "src/index.ts", size: 2 },
    { type: "file", relativePath: "src/stale.ts", size: 1 },
    { type: "file", relativePath: ".env", size: 20 },
    { type: "directory", relativePath: "logs" },
    { type: "file", relativePath: "logs/app.log", size: 100 },
  ];
  const plan = buildSyncPlan(manifest({ "src/index.ts": { size: 3 } }), remote, exclusions);
  assert.deepEqual(plan.uploadFiles, ["src/index.ts"]);
  assert.deepEqual(plan.deleteFiles, ["src/stale.ts"]);
  assert.ok(plan.protectedPaths.includes(".env"));
  assert.ok(plan.protectedPaths.includes("logs/app.log"));
  assert.ok(plan.protectedPaths.includes("logs"));
});

test("strict plan never replaces an ancestor that contains protected remote data", () => {
  const remote: RemoteMirrorEntry[] = [
    { type: "directory", relativePath: "logs" },
    { type: "file", relativePath: "logs/app.log", size: 10 },
  ];
  const plan = buildSyncPlan(manifest({ "logs": { size: 3 } }), remote, exclusions);
  assert.deepEqual(plan.replaceTypeConflicts, []);
  assert.deepEqual(plan.uploadFiles, []);
  assert.ok(plan.protectedPaths.includes("logs"));
});

test("strict plan removes directories deepest first", () => {
  const remote: RemoteMirrorEntry[] = [
    { type: "directory", relativePath: "old" },
    { type: "directory", relativePath: "old/deep" },
    { type: "file", relativePath: "old/deep/file", size: 1 },
  ];
  const plan = buildSyncPlan(manifest({}), remote, exclusions);
  assert.deepEqual(plan.deleteFiles, ["old/deep/file"]);
  assert.deepEqual(plan.deleteDirectories, ["old/deep", "old"]);
});

test("remote protection rules re-include environment templates", () => {
  const rules = new MirrorExclusions([], [".env", ".env.*", "!.env.example"]);
  assert.equal(rules.isRemoteProtected(".env"), true);
  assert.equal(rules.isRemoteProtected(".env.production"), true);
  assert.equal(rules.isRemoteProtected(".env.example"), false);
});

test("marker and local credential paths cannot be negated by user rules", () => {
  const rules = new MirrorExclusions(["!.git/config", "!keys/.ssh/id_ed25519"], ["!.pi-ssh-sync.json"]);
  assert.equal(rules.isLocalExcluded(".git/config"), true);
  assert.equal(rules.isLocalExcluded("keys/.ssh/id_ed25519"), true);
  assert.equal(rules.isRemoteProtected(".pi-ssh-sync.json"), true);
});
