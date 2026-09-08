import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  getDefaultOpenSshConfigPath,
  stageManagedKey,
  validateManagedKeyName,
  validatePrivateKey,
} from "../extensions/ssh-remote/src/servers/managed-key.ts";

function privateKey(): string {
  return generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs1" }).toString();
}

test("managed key names stay inside the Pi SSH directory", () => {
  assert.equal(validateManagedKeyName("id_ed25519_test"), "id_ed25519_test");
  for (const value of ["", ".", "..", "../key", "a/b", "a\\b", "a\nkey"]) {
    assert.throws(() => validateManagedKeyName(value), /密钥文件名/);
  }
  assert.equal(getDefaultOpenSshConfigPath("/local/pi"), join("/local/pi", "ssh", "config"));
});

test("managed key transaction writes 0600 and rolls back new and overwritten files", async () => {
  const root = mkdtempSync(join(tmpdir(), "ssh-managed-key-"));
  const sshDir = join(root, "ssh");
  try {
    const created = await stageManagedKey("new_key", privateKey(), sshDir);
    assert.equal(lstatSync(sshDir).mode & 0o777, 0o700);
    assert.equal(lstatSync(created.path).mode & 0o777, 0o600);
    await created.rollback();
    assert.equal(existsSync(created.path), false);

    const path = join(sshDir, "existing_key");
    writeFileSync(path, "original", { mode: 0o640 });
    const overwritten = await stageManagedKey("existing_key", privateKey(), sshDir);
    assert.notEqual(readFileSync(path, "utf8"), "original");
    await overwritten.rollback();
    assert.equal(readFileSync(path, "utf8"), "original");
    assert.equal(lstatSync(path).mode & 0o777, 0o640);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("managed key storage rejects a symlinked managed directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "ssh-managed-link-"));
  const outside = mkdtempSync(join(tmpdir(), "ssh-managed-outside-"));
  try {
    symlinkSync(outside, join(root, "ssh"), "dir");
    await assert.rejects(stageManagedKey("test_key", privateKey(), join(root, "ssh")), /托管目录/);
    assert.equal(existsSync(join(outside, "test_key")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("managed key validation rejects public, encrypted, invalid, and oversized input", async () => {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicKey = pair.publicKey.export({ format: "pem", type: "spki" }).toString();
  const encrypted = pair.privateKey.export({ format: "pem", type: "pkcs8", cipher: "aes-256-cbc", passphrase: "test-only" }).toString();
  await assert.rejects(validatePrivateKey(publicKey), /私钥/);
  await assert.rejects(validatePrivateKey(encrypted), /加密私钥/);
  await assert.rejects(validatePrivateKey("not a key"), /无效/);
  await assert.rejects(validatePrivateKey("x".repeat(1024 * 1024 + 1)), /1 MiB/);
});
