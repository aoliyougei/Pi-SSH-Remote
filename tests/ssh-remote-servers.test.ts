import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerSshManagementCommands } from "../extensions/ssh-remote/src/servers/commands.ts";
import { ServerConnectionPool } from "../extensions/ssh-remote/src/servers/connection-pool.ts";
import { getDefaultOpenSshConfigPath } from "../extensions/ssh-remote/src/servers/managed-key.ts";
import { loadServerStore, normalizeServerStore, saveServerStore, UnsupportedStoreVersionError } from "../extensions/ssh-remote/src/servers/store.ts";
import { ServerController } from "../extensions/ssh-remote/src/servers/controller.ts";
import type { SavedSshServer } from "../extensions/ssh-remote/src/servers/types.ts";
import { buildSshArguments } from "../extensions/ssh-remote/src/transport/client.ts";
import { SshPasswordResolver } from "../extensions/ssh-remote/src/transport/password-resolver.ts";

function fixtureServer(id = "server-1", updatedAt = "2026-01-01T00:00:00.000Z"): SavedSshServer {
  return { version: 1, id, name: id, target: "deploy@devbox", authenticationPreference: "auto", shellPreference: "auto", transportPreference: "auto", createdAt: "2026-01-01T00:00:00.000Z", updatedAt };
}

const ctx = { hasUI: false, ui: { input: async () => undefined, notify: () => {} } } as unknown as ExtensionContext;

test("server store rejects duplicate names case-insensitively", () => {
  assert.throws(() => normalizeServerStore({ version: 1, servers: [
    { ...fixtureServer("a"), name: "Test-API" },
    { ...fixtureServer("b"), name: "test-api" },
  ] }), /duplicate SSH server name/i);
});

test("server store normalizes legacy authentication and validates key identity", () => {
  const { authenticationPreference: _authenticationPreference, ...legacy } = fixtureServer();
  const normalized = normalizeServerStore({ version: 1, servers: [legacy] });
  assert.equal(normalized.servers[0].authenticationPreference, "auto");
  assert.equal(normalized.servers[0].identityFile, undefined);
  assert.throws(() => normalizeServerStore({ version: 1, servers: [{
    ...fixtureServer(), authenticationPreference: "key",
  }] }), /identity/i);
});

test("OpenSSH arguments honor explicit authentication preference", () => {
  const password = buildSshArguments({ target: "deploy@devbox", authenticationPreference: "password" });
  assert.ok(password.includes("PreferredAuthentications=password,keyboard-interactive,publickey"));

  const key = buildSshArguments({ target: "deploy@devbox", authenticationPreference: "key", identityFile: "/home/deploy/.ssh/test_key" });
  assert.deepEqual(key.slice(0, 6), ["-i", "/home/deploy/.ssh/test_key", "-o", "IdentitiesOnly=no", "-o", "PreferredAuthentications=publickey,password,keyboard-interactive"]);
  assert.throws(() => buildSshArguments({ target: "deploy@devbox", authenticationPreference: "key" }), /identity/i);
});

test("server store drops credential-shaped unknown fields and writes atomically", () => {
  const normalized = normalizeServerStore({ version: 1, servers: [{ ...fixtureServer(), password: "forbidden", privateKey: "forbidden" }] });
  assert.equal("password" in normalized.servers[0], false);
  const root = mkdtempSync(join(tmpdir(), "ssh-server-store-"));
  const path = join(root, "servers.json");
  try {
    saveServerStore(normalized, path);
    assert.deepEqual(loadServerStore(path), normalized);
    assert.doesNotMatch(readFileSync(path, "utf8"), /forbidden|password|privateKey/);
    writeFileSync(path, "{broken");
    assert.deepEqual(loadServerStore(path), { version: 1, servers: [] });
    assert.throws(() => normalizeServerStore({ version: 2, servers: [] }), UnsupportedStoreVersionError);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("password resolver remembers selected passwords according to persistence", () => {
  const root = mkdtempSync(join(tmpdir(), "ssh-password-store-"));
  const endpoint = { hostLabel: "deploy@devbox:22", username: "deploy", host: "devbox", port: 22 };
  try {
    const memoryPath = join(root, "memory.json");
    const memory = new SshPasswordResolver({ persistPasswords: false, secretsPath: memoryPath });
    memory.rememberPassword(endpoint, "memory-only");
    assert.equal(memory.cachedPassword(endpoint), "memory-only");
    assert.equal(readFileSync(memoryPath, { encoding: "utf8", flag: "a+" }), "");

    const persistedPath = join(root, "persisted.json");
    const persisted = new SshPasswordResolver({ persistPasswords: true, secretsPath: persistedPath });
    persisted.rememberPassword(endpoint, "persisted-test-value");
    assert.equal(JSON.parse(readFileSync(persistedPath, "utf8"))[endpoint.hostLabel], "persisted-test-value");
    assert.equal(statSync(persistedPath).mode & 0o777, 0o600);
    assert.throws(() => persisted.rememberPassword(endpoint, ""), /密码不能为空/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("password servers use cached credentials even when password prompts are disabled", async () => {
  const endpoint = { hostLabel: "deploy@devbox:22", username: "deploy", host: "devbox", port: 22 };
  const resolver = new SshPasswordResolver({ persistPasswords: false, secretsPath: join(tmpdir(), "unused-secrets.json") });
  resolver.rememberPassword(endpoint, "cached-test-value");
  let provider: any;
  const pool = new ServerConnectionPool({
    passwordResolver: resolver,
    passwordEnabled: () => false,
    createClient: ((options: any, factory: any) => { provider = factory.passwordProvider; return { options, dispose: async () => {} }; }) as any,
    selectRemote: async () => ({ adapter: {} as any, workspace: { platform: "unix", shell: "bash", home: "/home/deploy", cwd: "/home/deploy" } }),
  });
  const lease = await pool.acquire({ ...fixtureServer(), authenticationPreference: "password" }, ctx);
  assert.equal(provider.cached(endpoint), "cached-test-value");
  assert.equal(await provider.retry(endpoint), undefined);
  await lease.release();
  await pool.shutdown();
});

test("server pool passes saved authentication options to transport", async () => {
  let options: any;
  const pool = new ServerConnectionPool({
    passwordResolver: new SshPasswordResolver({ persistPasswords: false, secretsPath: join(tmpdir(), "unused-secrets.json") }),
    createClient: ((value: any) => { options = value; return { options: value, dispose: async () => {} }; }) as any,
    selectRemote: async () => ({ adapter: {} as any, workspace: { platform: "unix", shell: "bash", home: "/home/deploy", cwd: "/home/deploy" } }),
  });
  const lease = await pool.acquire({ ...fixtureServer(), authenticationPreference: "key", identityFile: "/home/deploy/.ssh/test_key" }, ctx);
  assert.equal(options.authenticationPreference, "key");
  assert.equal(options.identityFile, "/home/deploy/.ssh/test_key");
  await lease.release();
  await pool.shutdown();
});

test("server pool deduplicates setup and retires changed generations", async () => {
  let creates = 0;
  let disposes = 0;
  const clients: any[] = [];
  const createClient = (options: any) => {
    creates++;
    const client = { options, transport: "ssh2", reusesConnection: true, run: async () => ({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 }), runChecked: async () => ({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 }), dispose: async () => { disposes++; } };
    clients.push(client);
    return client;
  };
  const pool = new ServerConnectionPool({
    passwordResolver: new SshPasswordResolver({ persistPasswords: false, secretsPath: join(tmpdir(), "unused-secrets.json") }),
    createClient: createClient as any,
    selectRemote: async () => ({ adapter: {} as any, workspace: { platform: "unix", shell: "bash", home: "/home/deploy", cwd: "/home/deploy" } }),
  });
  const first = fixtureServer();
  const [a, b] = await Promise.all([pool.acquire(first, ctx), pool.acquire(first, ctx)]);
  assert.equal(creates, 1);
  await a.release(); await b.release();
  const changed = { ...first, target: "deploy@newbox", updatedAt: "2026-01-02T00:00:00.000Z" };
  const c = await pool.acquire(changed, ctx);
  assert.equal(creates, 2);
  assert.ok(disposes >= 1);
  await c.release();
  await pool.shutdown();
});

test("/ssh add uses Chinese prompts, visible default config, and selected password", async () => {
  let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
  const inputs = ["test-api", "测试服务器", "deploy@devbox", "", getDefaultOpenSshConfigPath(), "test-password"];
  const prompts: Array<{ title: string; placeholder?: string }> = [];
  const selections = ["密码认证", "auto（自动）", "auto（自动）"];
  let remembered: { password: string; server: SavedSshServer } | undefined;
  let saved: SavedSshServer | undefined;
  registerSshManagementCommands({ registerCommand: (_name: string, command: any) => { handler = command.handler; } } as any, {
    servers: new ServerController({ load: () => ({ version: 1, servers: [] }), save: (document) => { saved = document.servers[0]; } }),
    mappings: { list: () => [] } as any,
    connections: {
      rememberPassword: async (server: SavedSshServer, password: string) => { remembered = { server, password }; },
      acquire: async () => ({ client: { transport: "ssh2", reusesConnection: true }, workspace: { platform: "unix", shell: "bash", home: "/home/deploy", cwd: "/home/deploy" }, release: async () => {} }),
    } as any,
    isFullRemoteWorkspace: () => false,
  });
  await handler!("add", {
    hasUI: true,
    cwd: "/local/workspace",
    waitForIdle: async () => {},
    ui: {
      input: async (title: string, placeholder?: string) => { prompts.push({ title, placeholder }); return inputs.shift(); },
      select: async () => selections.shift(),
      notify: () => {},
    },
  });
  assert.equal(prompts[4].placeholder, getDefaultOpenSshConfigPath());
  assert.equal(remembered?.password, "test-password");
  assert.equal(saved?.authenticationPreference, "password");
  assert.equal(saved?.identityFile, undefined);
});

test("/ssh add rolls back a staged managed key when connection testing fails", async () => {
  let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
  const root = mkdtempSync(join(tmpdir(), "ssh-add-key-"));
  const inputs = ["test-key", "", "deploy@devbox", "", getDefaultOpenSshConfigPath(), "managed_key"];
  const selections = ["密钥认证", "auto（自动）", "auto（自动）"];
  const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs1" }).toString();
  try {
    registerSshManagementCommands({ registerCommand: (_name: string, command: any) => { handler = command.handler; } } as any, {
      servers: new ServerController({ load: () => ({ version: 1, servers: [] }), save: () => {} }),
      mappings: { list: () => [] } as any,
      connections: { acquire: async () => { throw new Error("connection refused"); } } as any,
      isFullRemoteWorkspace: () => false,
      managedKeyDirectory: root,
    });
    await handler!("add", { hasUI: true, cwd: "/local/workspace", waitForIdle: async () => {}, ui: {
      input: async () => inputs.shift(), select: async () => selections.shift(), editor: async () => key,
      confirm: async () => true, notify: () => {},
    } });
    assert.equal(existsSync(join(root, "managed_key")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("server pool connection failure remains isolated", async () => {
  const pool = new ServerConnectionPool({
    passwordResolver: new SshPasswordResolver({ persistPasswords: false, secretsPath: join(tmpdir(), "unused-secrets.json") }),
    createClient: ((options: any) => ({ options, dispose: async () => {}, run: async () => { throw new Error("unused"); }, runChecked: async () => { throw new Error("unused"); } })) as any,
    selectRemote: async () => { throw new Error("connection refused"); },
  });
  await assert.rejects(pool.acquire(fixtureServer(), ctx), /connection refused/);
  await pool.shutdown();
});
