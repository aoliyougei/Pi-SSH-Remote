import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ChangedSshHostKeyError,
  getPersistentKnownHostsPath,
  parseSshHostKeyBlob,
  trustHostKey,
} from "../extensions/ssh-remote/src/host-trust/index.ts";

function sshString(value: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(value.length);
  return Buffer.concat([length, value]);
}

function hostKeyBlob(type = "ssh-ed25519", marker = "test-public-key"): Buffer {
  return Buffer.concat([sshString(Buffer.from(type)), sshString(Buffer.from(marker))]);
}

test("host key candidates use OpenSSH host tokens and SHA-256 fingerprints", () => {
  const key = hostKeyBlob();
  const standard = parseSshHostKeyBlob(key, { host: "server.example.test", port: 22, role: "target" });
  assert.equal(standard.lookupHost, "server.example.test");
  assert.equal(standard.keyType, "ssh-ed25519");
  assert.equal(standard.fingerprint, `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`);
  assert.equal(standard.keyBase64, key.toString("base64"));
  assert.equal(parseSshHostKeyBlob(key, { host: "server.example.test", port: 2201, role: "jump" }).lookupHost, "[server.example.test]:2201");
  assert.equal(parseSshHostKeyBlob(key, { host: "server.example.test", port: 22, hostKeyAlias: "stable-name", role: "target" }).lookupHost, "stable-name");
});

test("persistent known_hosts path follows the Pi agent directory", () => {
  assert.equal(getPersistentKnownHostsPath("/local/pi-agent"), join("/local/pi-agent", "ssh", "known_hosts"));
});

test("trust store appends idempotently with 0700/0600 permissions and preserves content", () => {
  const root = mkdtempSync(join(tmpdir(), "ssh-host-trust-"));
  const path = join(root, "ssh", "known_hosts");
  const candidate = parseSshHostKeyBlob(hostKeyBlob(), { host: "server.example.test", port: 22, role: "target" });
  try {
    trustHostKey(candidate, path);
    trustHostKey(candidate, path);
    assert.equal(lstatSync(join(root, "ssh")).mode & 0o777, 0o700);
    assert.equal(lstatSync(path).mode & 0o777, 0o600);
    const first = readFileSync(path, "utf8");
    assert.equal(first.trim().split("\n").length, 1);
    writeFileSync(path, `# retained\n${first}`, { mode: 0o600 });
    const second = parseSshHostKeyBlob(hostKeyBlob("ssh-ed25519", "another-key"), { host: "other.example.test", port: 22, role: "target" });
    trustHostKey(second, path);
    assert.match(readFileSync(path, "utf8"), /^# retained\n/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("trust store rejects changed keys, symlinks, and oversized files", () => {
  const root = mkdtempSync(join(tmpdir(), "ssh-host-trust-safe-"));
  const path = join(root, "known_hosts");
  const first = parseSshHostKeyBlob(hostKeyBlob(), { host: "server.example.test", port: 22, role: "target" });
  const changed = parseSshHostKeyBlob(hostKeyBlob("ssh-ed25519", "changed-key"), { host: "server.example.test", port: 22, role: "target" });
  try {
    trustHostKey(first, path);
    assert.throws(() => trustHostKey(changed, path), ChangedSshHostKeyError);
    rmSync(path);
    const outside = join(root, "outside");
    writeFileSync(outside, "safe");
    symlinkSync(outside, path);
    assert.throws(() => trustHostKey(first, path), /符号链接|普通文件/);
    assert.equal(readFileSync(outside, "utf8"), "safe");
    rmSync(path);
    writeFileSync(path, Buffer.alloc(16 * 1024 * 1024 + 1));
    assert.throws(() => trustHostKey(first, path), /16 MiB/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("trust store rejects a symlinked parent directory", () => {
  const root = mkdtempSync(join(tmpdir(), "ssh-host-parent-"));
  const outside = mkdtempSync(join(tmpdir(), "ssh-host-outside-"));
  try {
    symlinkSync(outside, join(root, "ssh"), "dir");
    const path = join(root, "ssh", "known_hosts");
    const candidate = parseSshHostKeyBlob(hostKeyBlob(), { host: "server.example.test", port: 22, role: "target" });
    assert.throws(() => trustHostKey(candidate, path), /目录/);
    assert.equal(existsSync(join(outside, "known_hosts")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
