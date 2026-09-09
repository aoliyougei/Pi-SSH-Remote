import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ChangedSshHostKeyError,
  UnknownSshHostKeyError,
  getPersistentKnownHostsPath,
  parseSshHostKeyBlob,
  trustHostKey,
} from "../extensions/ssh-remote/src/host-trust/index.ts";
import { resolveSsh2Connection } from "../extensions/ssh-remote/src/transport/ssh2-config.ts";
import { Ssh2Client } from "../extensions/ssh-remote/src/transport/ssh2-client.ts";

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

test("ssh2 resolver captures unknown, changed, and revoked host keys", async () => {
  const root = mkdtempSync(join(tmpdir(), "ssh-host-verifier-"));
  const path = join(root, "known_hosts");
  writeFileSync(path, "");
  const key = hostKeyBlob();
  const other = hostKeyBlob("ssh-ed25519", "other-key");
  const resolve = async (knownOutput: string) => resolveSsh2Connection(
    { target: "alias", knownHostsFile: path },
    { platform: "linux", home: root, env: {}, allowPasswordPrompt: true, runLocal: async (_executable, args) => args.includes("-G") ? {
      stdout: Buffer.from("user deploy\nhostname server.example.test\nport 22\nhostkeyalias stable-name\npubkeyauthentication true\nidentitiesonly no\n"), stderr: Buffer.alloc(0), exitCode: 0,
    } : { stdout: Buffer.from(knownOutput), stderr: Buffer.alloc(0), exitCode: knownOutput ? 0 : 1 } },
  );
  try {
    const unknown = await resolve("");
    assert.equal((unknown.config.hostVerifier as (value: Buffer) => boolean)(key), false);
    assert.equal(unknown.verification.kind, "unknown");
    assert.equal(unknown.verification.candidate?.lookupHost, "stable-name");

    const changed = await resolve(`stable-name ssh-ed25519 ${other.toString("base64")}\n`);
    assert.equal((changed.config.hostVerifier as (value: Buffer) => boolean)(key), false);
    assert.equal(changed.verification.kind, "changed");

    const revoked = await resolve(`@revoked stable-name ssh-ed25519 ${key.toString("base64")}\n`);
    assert.equal((revoked.config.hostVerifier as (value: Buffer) => boolean)(key), false);
    assert.equal(revoked.verification.kind, "revoked");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Ssh2Client preserves typed unknown host-key errors", async () => {
  const candidate = parseSshHostKeyBlob(hostKeyBlob(), { host: "server.example.test", port: 22, role: "target" });
  const verification = { kind: "unknown" as const, candidate, rejection: "unknown" };
  class RejectingClient extends EventEmitter {
    connect(): void { queueMicrotask(() => this.emit("error", Object.assign(new Error("handshake failed"), { level: "handshake" }))); }
    destroy(): void {}
  }
  const client = new Ssh2Client({ target: "server.example.test" }, {
    createClient: () => new RejectingClient() as any,
    resolveConnection: async () => ({ config: { host: candidate.host, username: "deploy" }, hostLabel: "deploy@server.example.test:22", warnings: [], verification }),
  });
  await assert.rejects(client.run("true"), UnknownSshHostKeyError);
  await client.dispose();
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
