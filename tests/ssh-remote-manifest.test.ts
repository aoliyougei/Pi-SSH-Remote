import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { MirrorExclusions } from "../extensions/ssh-remote/src/sync/exclusions.ts";
import { buildLocalManifest, type LocalGitRunner } from "../extensions/ssh-remote/src/sync/manifest.ts";
import { DEFAULT_REMOTE_PROTECTED_PATTERNS } from "../extensions/ssh-remote/src/mappings/types.ts";

function createFiles(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "ssh-mirror-manifest-"));
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, content);
  }
  return root;
}
const exclusions = () => new MirrorExclusions([], DEFAULT_REMOTE_PROTECTED_PATTERNS);
const noGit: LocalGitRunner = async () => ({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 1 });

test("Git manifest includes tracked and unignored files but excludes environment secrets", async () => {
  const root = createFiles({ "src/index.ts": "export const value = 1;\n", ".env": "SECRET=value\n", ".env.example": "SECRET=\n", ".gitignore": "node_modules/\n", "node_modules/pkg/index.js": "ignored\n" });
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "src/index.ts", ".env.example", ".gitignore"], { cwd: root });
    writeFileSync(join(root, "src", "new file.ts"), "new\n");
    const manifest = await buildLocalManifest(root, { exclusions: exclusions() });
    assert.equal(manifest.mode, "git");
    assert.ok(manifest.entries.has("src/index.ts"));
    assert.ok(manifest.entries.has("src/new file.ts"));
    assert.ok(manifest.entries.has(".env.example"));
    assert.equal(manifest.entries.has(".env"), false);
    assert.equal(manifest.entries.has("node_modules/pkg/index.js"), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("filesystem fallback applies nested gitignore rules", async () => {
  const root = createFiles({ ".gitignore": "cache/\n", "src/.gitignore": "generated/\n!generated/keep.ts\n", "src/index.ts": "ok\n", "src/generated/drop.ts": "drop\n", "src/generated/keep.ts": "keep\n", "cache/data": "ignored\n" });
  try {
    const manifest = await buildLocalManifest(root, { exclusions: exclusions(), git: noGit });
    assert.equal(manifest.mode, "filesystem");
    assert.ok(manifest.entries.has("src/index.ts"));
    assert.ok(manifest.entries.has("src/generated/keep.ts"));
    assert.equal(manifest.entries.has("src/generated/drop.ts"), false);
    assert.equal(manifest.entries.has("cache/data"), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("manifest rejects private key material without exposing its contents", async () => {
  const privateHeader = ["-----BEGIN", "OPENSSH PRIVATE KEY-----"].join(" ");
  const root = createFiles({ "src/index.ts": "ok\n", "secrets.txt": `${privateHeader}\n` });
  try { await assert.rejects(buildLocalManifest(root, { exclusions: exclusions(), git: noGit }), /Private key material.*secrets\.txt/); }
  finally { rmSync(root, { recursive: true, force: true }); }
});

test("manifest accepts internal relative symlinks and rejects escaping links", async (t) => {
  if (process.platform === "win32") { t.skip("symlink setup requires Windows privileges"); return; }
  const root = createFiles({ "packages/shared/value.ts": "shared\n" });
  mkdirSync(join(root, "src"), { recursive: true });
  symlinkSync("../packages/shared", join(root, "src", "shared"));
  try {
    const manifest = await buildLocalManifest(root, { exclusions: exclusions(), git: noGit });
    assert.equal(manifest.entries.get("src/shared")?.type, "symlink");
    rmSync(join(root, "src", "shared")); symlinkSync("../../outside", join(root, "src", "shared"));
    await assert.rejects(buildLocalManifest(root, { exclusions: exclusions(), git: noGit }), /escapes project root/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
