import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ServerConnectionPool } from "../extensions/ssh-remote/src/servers/connection-pool.ts";
import { loadServerStore, normalizeServerStore, saveServerStore, UnsupportedStoreVersionError } from "../extensions/ssh-remote/src/servers/store.ts";
import type { SavedSshServer } from "../extensions/ssh-remote/src/servers/types.ts";
import { SshPasswordResolver } from "../extensions/ssh-remote/src/transport/password-resolver.ts";

function fixtureServer(id = "server-1", updatedAt = "2026-01-01T00:00:00.000Z"): SavedSshServer {
  return { version: 1, id, name: id, target: "deploy@devbox", shellPreference: "auto", transportPreference: "auto", createdAt: "2026-01-01T00:00:00.000Z", updatedAt };
}

const ctx = { hasUI: false, ui: { input: async () => undefined, notify: () => {} } } as unknown as ExtensionContext;

test("server store rejects duplicate names case-insensitively", () => {
  assert.throws(() => normalizeServerStore({ version: 1, servers: [
    { ...fixtureServer("a"), name: "Test-API" },
    { ...fixtureServer("b"), name: "test-api" },
  ] }), /duplicate SSH server name/i);
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

test("server pool connection failure remains isolated", async () => {
  const pool = new ServerConnectionPool({
    passwordResolver: new SshPasswordResolver({ persistPasswords: false, secretsPath: join(tmpdir(), "unused-secrets.json") }),
    createClient: ((options: any) => ({ options, dispose: async () => {}, run: async () => { throw new Error("unused"); }, runChecked: async () => { throw new Error("unused"); } })) as any,
    selectRemote: async () => { throw new Error("connection refused"); },
  });
  await assert.rejects(pool.acquire(fixtureServer(), ctx), /connection refused/);
  await pool.shutdown();
});
