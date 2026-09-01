# SSH Remote Local Mirror and Remote Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a safe local-code/remote-runtime workflow to `@aoliyougei/pi-ssh-remote` while preserving the existing full SSH workspace behavior.

**Architecture:** Keep one extension package but add focused `servers`, `mappings`, `sync`, and `exec` subsystems. The existing extension owns authoritative workspace routing; a separate mirror controller owns local-to-remote state, and a separate server connection pool owns one-off synchronization and `ssh_exec` connections so their failures cannot contaminate full-workspace state.

**Tech Stack:** TypeScript strict mode, Bun 1.3.14, Node 24 APIs, Pi Extension API 0.83.x, TypeBox, existing OpenSSH/ssh2 transports and Unix/PowerShell adapters, Node test runner via `tsx`, `ignore@7.0.5` for Git-compatible ignore matching.

**Spec:** `docs/superpowers/specs/2026-08-31-local-mirror-remote-execution-design.md`

## Global Constraints

- Existing `/ssh-connect`, `/ssh-exit`, `/ssh-cd`, `/ssh-status`, `/ssh-reconnect`, `/ssh-forget-password`, remote tool routing, Background Tasks, ProxyJump, and branch restoration behavior must remain compatible.
- Remote synchronization may require only the SSH service plus POSIX `sh` on Unix or PowerShell on Windows; it must not require SFTP, rsync, tar, Git, Node.js, Python, or a remote agent.
- Local source is authoritative. Outside protected paths, successful synchronization means identical path sets, entry types, file SHA-256 values, safe symlink targets, and Unix executable bits.
- Remote protected defaults are `.pi-ssh-sync.json`, `.env`, `.env.*`, `node_modules/**`, `logs/**`, `uploads/**`, `runtime/**`, `tmp/**`, and `*.pid`; `.env.example`, `.env.sample`, and `.env.template` are re-included.
- Default debounce is 1500 ms, valid range 250–30000 ms.
- Default limits are 20,000 files, 100 MB per file, 2 GB per pass, depth 64, and 1,000 symlinks.
- Tool output remains bounded to 50 KB or 2,000 lines.
- Never persist or expose passwords, private-key contents, local session file paths, real developer identities, or machine-specific test data.
- Automatic synchronization, initial synchronization, mapping-driven `ssh_sync`, and mapping-driven `ssh_exec` require `ctx.isProjectTrusted() === true`; untrusted projects must not create watchers or remote connections.
- Every production change follows red-green-refactor; run `bun run check:privacy` whenever tests or fixtures change.
- Keep Pi/runtime packages external in the staged npm bundle and retain `dist/ssh-remote/index.min.js` plus linked source map.

---

## Locked File Structure

Create these focused modules:

```text
extensions/ssh-remote/src/servers/{types,store,connection-pool,controller,commands}.ts
extensions/ssh-remote/src/mappings/{types,store,controller}.ts
extensions/ssh-remote/src/sync/{types,exclusions,git-manifest,filesystem-manifest,manifest,marker,remote-tree,synchronizer,verifier,queue,watcher}.ts
extensions/ssh-remote/src/exec/{policy,controller,tools}.ts
```

Create tests:

```text
tests/ssh-remote-servers.test.ts
tests/ssh-remote-mappings.test.ts
tests/ssh-remote-manifest.test.ts
tests/ssh-remote-sync.test.ts
tests/ssh-remote-watcher.test.ts
tests/ssh-remote-exec.test.ts
tests/ssh-remote-mode-integration.test.ts
```

Modify existing files only for integration:

```text
extensions/ssh-remote/src/adapters/types.ts
extensions/ssh-remote/src/adapters/unix.ts
extensions/ssh-remote/src/adapters/windows.ts
extensions/ssh-remote/src/config.ts
extensions/ssh-remote/src/settings.ts
extensions/ssh-remote/src/extension.ts
extensions/ssh-remote/index.ts
extensions/ssh-remote/package.json
package.json
bun.lock
extensions/ssh-remote/README.md
README.md
tests/README.md
```

## Shared Test Harness Contracts

Each new test file defines its own local helpers rather than importing production-only test utilities. Use these exact contracts consistently:

```ts
function fixtureServer(
  id = "server-1",
  updatedAt = "2026-01-01T00:00:00.000Z",
): SavedSshServer;

function fixtureMapping(
  id = "mapping-1",
  localRoot = "/local/workspace",
): LocalProjectMapping;

function fixtureContext(overrides?: Partial<ExtensionContext>): ExtensionContext;
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void };
const nextTick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
```

`fixtureServer()` always returns target `deploy@devbox`, transport/shell `auto`, and no credential fields. `fixtureMapping()` always returns server `server-1`, remote root `/srv/test/project`, marker/project IDs derived from its ID, auto-sync enabled, debounce 1500, and the spec’s default protection rules.

Specialized harnesses (`createManagementHarness`, `createExecHarness`, `createModeHarness`, fake remote adapters, and fake clock/watcher factories) must be declared at the top of their owning test file before the first test. Each harness records observable calls in arrays, implements only the exact injected interfaces consumed by production code, uses fictional paths/hosts, and never reaches the network. Their method/property names are the ones shown in the task test snippets; do not invent alternate names in implementation tasks.

---

### Task 1: Versioned Server and Mapping Stores

**Files:**
- Create: `extensions/ssh-remote/src/servers/types.ts`
- Create: `extensions/ssh-remote/src/servers/store.ts`
- Create: `extensions/ssh-remote/src/mappings/types.ts`
- Create: `extensions/ssh-remote/src/mappings/store.ts`
- Test: `tests/ssh-remote-servers.test.ts`
- Test: `tests/ssh-remote-mappings.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces `SavedSshServer`, `SshServerStoreDocument`, `normalizeServerStore()`, `loadServerStore()`, and `saveServerStore()`.
- Produces `LocalProjectMapping`, `MappingStoreDocument`, `normalizeMappingStore()`, `loadMappingStore()`, and `saveMappingStore()`.
- Both stores accept injectable paths for tests and throw `UnsupportedStoreVersionError` for versions newer than 1.

- [ ] **Step 1: Register the new test files in the root test script**

Append `tests/ssh-remote-servers.test.ts tests/ssh-remote-mappings.test.ts` to the explicit `node --test` list in `package.json`.

- [ ] **Step 2: Write failing server-store tests**

```ts
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  normalizeServerStore,
  saveServerStore,
  loadServerStore,
  UnsupportedStoreVersionError,
} from "../extensions/ssh-remote/src/servers/store.ts";

test("server store rejects duplicate names case-insensitively", () => {
  assert.throws(() => normalizeServerStore({ version: 1, servers: [
    { version: 1, id: "a", name: "Test-API", target: "deploy@devbox", shellPreference: "auto", transportPreference: "auto", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
    { version: 1, id: "b", name: "test-api", target: "deploy@devbox", shellPreference: "auto", transportPreference: "auto", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
  ] }), /duplicate server name/i);
});

test("server store drops credential-shaped unknown fields", () => {
  const value = normalizeServerStore({ version: 1, servers: [{
    ...fixtureServer(), password: "forbidden", privateKey: "forbidden",
  }] });
  assert.equal("password" in value.servers[0], false);
  assert.equal("privateKey" in value.servers[0], false);
});

test("server store writes atomically and rejects future versions", () => {
  const root = mkdtempSync(join(tmpdir(), "ssh-server-store-"));
  const path = join(root, "servers.json");
  try {
    saveServerStore({ version: 1, servers: [] }, path);
    assert.deepEqual(loadServerStore(path), { version: 1, servers: [] });
    assert.doesNotMatch(readFileSync(path, "utf8"), /password|privateKey/);
    assert.throws(() => normalizeServerStore({ version: 2, servers: [] }), UnsupportedStoreVersionError);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 3: Write failing mapping-store tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeMappingStore } from "../extensions/ssh-remote/src/mappings/store.ts";

test("mapping store applies safe defaults and rejects invalid debounce", () => {
  const value = normalizeMappingStore({ version: 1, mappings: [{
    version: 1,
    id: "mapping-1",
    projectId: "project-1",
    localRoot: "/local/workspace",
    localRootCanonical: "/local/workspace",
    serverId: "server-1",
    remoteRoot: "/srv/test/project",
    markerId: "marker-1",
    autoSync: true,
    debounceMs: 1500,
    localExcludePatterns: [],
    remoteProtectedPatterns: [],
    matchSubdirectories: true,
    paused: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }] });
  assert.equal(value.mappings[0].debounceMs, 1500);
  assert.ok(value.mappings[0].remoteProtectedPatterns.includes(".pi-ssh-sync.json"));
  assert.throws(() => normalizeMappingStore({ ...value, mappings: [{ ...value.mappings[0], debounceMs: 100 }] }), /250.*30000/);
});
```

- [ ] **Step 4: Run tests and verify RED**

Run:

```bash
node --import tsx --test --test-isolation=process tests/ssh-remote-servers.test.ts tests/ssh-remote-mappings.test.ts
```

Expected: FAIL because the store modules do not exist.

- [ ] **Step 5: Implement strict types, normalization, and atomic stores**

Use exact public shapes from the spec. Store top-level documents as `{ version: 1, servers: [...] }` and `{ version: 1, mappings: [...] }`. Validate target with the existing target safety rules, port 1–65535, name with `/^[A-Za-z0-9._-]+$/`, timestamps as strings, IDs as non-empty control-character-free strings, and paths as absolute local/remote strings. Save via `<path>.tmp-<pid>-<uuid>` then `renameSync()`.

- [ ] **Step 6: Run focused tests and privacy scan**

```bash
node --import tsx --test --test-isolation=process tests/ssh-remote-servers.test.ts tests/ssh-remote-mappings.test.ts
bun run check:privacy
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add package.json tests/ssh-remote-servers.test.ts tests/ssh-remote-mappings.test.ts extensions/ssh-remote/src/servers extensions/ssh-remote/src/mappings
git commit -m "feat(ssh-remote): add server and project mapping stores"
```

---

### Task 2: Mapping Resolution and Transactional Controller

**Files:**
- Create: `extensions/ssh-remote/src/mappings/controller.ts`
- Modify: `extensions/ssh-remote/src/mappings/types.ts`
- Test: `tests/ssh-remote-mappings.test.ts`

**Interfaces:**
- Consumes `LocalProjectMapping` and mapping-store functions from Task 1.
- Produces `canonicalizeLocalRoot(path, platform?)`, `findProjectMapping(cwd, mappings, platform?)`, and `MappingController` methods `add()`, `updateTransactional()`, `remove()`, `pause()`, and `resume()`.
- `updateTransactional(mappingId, candidate, validate)` commits only after `validate(candidate)` resolves.

- [ ] **Step 1: Add failing nearest-ancestor and transaction tests**

```ts
test("mapping resolution selects the nearest canonical ancestor", async () => {
  const mappings = [
    fixtureMapping("root", "/local/workspace"),
    fixtureMapping("api", "/local/workspace/packages/api"),
  ];
  assert.equal(findProjectMapping("/local/workspace/packages/api/src", mappings, "linux")?.id, "api");
  assert.equal(findProjectMapping("/local/other", mappings, "linux"), undefined);
});

test("mapping updates preserve the previous target when validation fails", async () => {
  const controller = createMemoryMappingController([fixtureMapping("root", "/local/workspace")]);
  await assert.rejects(controller.updateTransactional("root", { remoteRoot: "/srv/test/new" }, async () => {
    throw new Error("marker mismatch");
  }), /marker mismatch/);
  assert.equal(controller.get("root")?.remoteRoot, "/srv/test/project");
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Expected: missing exports.

- [ ] **Step 3: Implement canonical matching and transactions**

Use `realpathSync.native()` for existing local roots, `resolve()` fallback for missing paths, `win32.normalize().toLowerCase()` on Windows, and separator-aware ancestor checks. Keep immutable snapshots and increment a numeric controller generation after every committed mutation.

- [ ] **Step 4: Run focused tests**

```bash
node --import tsx --test --test-isolation=process tests/ssh-remote-mappings.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extensions/ssh-remote/src/mappings tests/ssh-remote-mappings.test.ts
git commit -m "feat(ssh-remote): resolve local project mappings safely"
```

---

### Task 3: Saved-Server Connection Pool

**Files:**
- Create: `extensions/ssh-remote/src/servers/connection-pool.ts`
- Create: `extensions/ssh-remote/src/servers/controller.ts`
- Test: `tests/ssh-remote-servers.test.ts`

**Interfaces:**
- Consumes `createSshTransportClient()`, `selectRemoteAdapter()`, `SshPasswordResolver`, and `SavedSshServer`.
- Produces `ServerConnectionLease { client, adapter, workspace, release() }`.
- Produces `ServerConnectionPool.acquire(server, ctx, signal?)`, `invalidate(serverId)`, and `shutdown()`.
- Pool receives dependencies for clock, client creation, and adapter selection; idle timeout defaults to 600,000 ms.

- [ ] **Step 1: Add failing pool tests**

```ts
test("server pool deduplicates connection setup and retires changed generations", async () => {
  let creates = 0;
  const pool = createFixturePool({ createClient: () => { creates++; return fakeClient(); } });
  const server = fixtureServer("server-1", "2026-01-01T00:00:00.000Z");
  const [a, b] = await Promise.all([pool.acquire(server, fixtureCtx()), pool.acquire(server, fixtureCtx())]);
  assert.equal(creates, 1);
  await a.release(); await b.release();
  const changed = { ...server, target: "deploy@newbox", updatedAt: "2026-01-02T00:00:00.000Z" };
  const c = await pool.acquire(changed, fixtureCtx());
  assert.equal(creates, 2);
  await c.release();
  await pool.shutdown();
});

test("pool connection failure does not publish full-workspace disconnect", async () => {
  const events: string[] = [];
  const pool = createFixturePool({ createClient: () => failingClient("connection refused"), onWorkspaceFailure: () => events.push("wrong") });
  await assert.rejects(pool.acquire(fixtureServer(), fixtureCtx()), /connection refused/);
  assert.deepEqual(events, []);
});
```

- [ ] **Step 2: Verify RED**

Run the server test file; expect missing pool exports.

- [ ] **Step 3: Implement immutable, reference-counted leases**

Key entries by `server.id` plus `updatedAt`. Deduplicate in-flight setup promises. Capture the saved server configuration before constructing `SshClientOptions`. Do not call existing full-workspace `markConnectionLost`; remove failed entries locally. Idle-close only when reference count reaches zero. Coalesce password prompts by sharing setup promise.

- [ ] **Step 4: Run tests**

```bash
node --import tsx --test --test-isolation=process tests/ssh-remote-servers.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extensions/ssh-remote/src/servers tests/ssh-remote-servers.test.ts
git commit -m "feat(ssh-remote): add isolated saved-server connection pool"
```

---

### Task 4: Server and Mapping Management Commands

**Files:**
- Create: `extensions/ssh-remote/src/servers/commands.ts`
- Modify: `extensions/ssh-remote/src/servers/controller.ts`
- Modify: `extensions/ssh-remote/src/mappings/controller.ts`
- Modify: `extensions/ssh-remote/src/extension.ts`
- Test: `tests/ssh-remote-servers.test.ts`
- Test: `tests/ssh-remote-mappings.test.ts`

**Interfaces:**
- Produces `registerSshManagementCommands(pi, dependencies)`.
- At this checkpoint registers `/ssh` with working `add|edit|rm|ls|test|config` server routes only.
- Task 13 extends the same command router with `map|sync` after marker preview, strict synchronization, and watcher interfaces exist; no temporary or nonfunctional mapping route is exposed.

- [ ] **Step 1: Add failing command registration and no-mode-switch tests**

```ts
test("/ssh test checks a saved server without switching workspace", async () => {
  const harness = createManagementHarness();
  registerSshManagementCommands(harness.pi, harness.dependencies);
  await harness.commands.get("ssh").handler("test test-api", harness.ctx);
  assert.equal(harness.connectionTests, 1);
  assert.equal(harness.workspaceTransitions, 0);
  assert.match(harness.notifications.at(-1)?.message ?? "", /reachable/);
});

test("removing a referenced server requires removing its mappings", async () => {
  const harness = createManagementHarness({ mappingCount: 1, confirm: false });
  registerSshManagementCommands(harness.pi, harness.dependencies);
  await harness.commands.get("ssh").handler("rm test-api", harness.ctx);
  assert.equal(harness.serverExists("test-api"), true);
});
```

- [ ] **Step 2: Verify RED**

Expected: command module missing.

- [ ] **Step 3: Implement management routing and UI flows**

Use `ctx.ui.select/input/confirm`, guard TUI menus with `ctx.hasUI`, and retain concrete subcommands for RPC/headless callers. Never ask for or display a password. Test connection via `ServerConnectionPool.acquire()` and immediately release/invalidate the temporary lease. Keep `/ssh-connect` unchanged.

- [ ] **Step 4: Run focused and existing SSH command tests**

```bash
node --import tsx --test --test-isolation=process tests/ssh-remote-servers.test.ts tests/ssh-remote-mappings.test.ts tests/ssh-remote.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extensions/ssh-remote/src/servers extensions/ssh-remote/src/mappings extensions/ssh-remote/src/extension.ts tests/ssh-remote-servers.test.ts tests/ssh-remote-mappings.test.ts
git commit -m "feat(ssh-remote): add SSH server and project mapping commands"
```

---

### Task 5: Ignore Rules and Local Manifests

**Files:**
- Create: `extensions/ssh-remote/src/sync/types.ts`
- Create: `extensions/ssh-remote/src/sync/exclusions.ts`
- Create: `extensions/ssh-remote/src/sync/git-manifest.ts`
- Create: `extensions/ssh-remote/src/sync/filesystem-manifest.ts`
- Create: `extensions/ssh-remote/src/sync/manifest.ts`
- Test: `tests/ssh-remote-manifest.test.ts`
- Modify: `extensions/ssh-remote/package.json`
- Modify: `package.json`
- Modify: `bun.lock`

**Interfaces:**
- Produces `LocalMirrorManifest`, `LocalManifestEntry`, and `SyncLimits`.
- Produces `buildLocalManifest(root, options): Promise<LocalMirrorManifest>`.
- Produces ordered `MirrorExclusions` with `isLocalExcluded(path)` and `isRemoteProtected(path)`.

- [ ] **Step 1: Add `ignore@7.0.5` and register the test file**

Declare `ignore` in both source package and root dependencies, run `bun install`, and append `tests/ssh-remote-manifest.test.ts` to the test script.

- [ ] **Step 2: Write failing Git and fallback tests**

```ts
test("Git manifest includes tracked and unignored files but protects environment secrets", async () => {
  const root = await createGitFixture({
    "src/index.ts": "export const value = 1;\n",
    "src/new file.ts": "new\n",
    ".env": "SECRET=value\n",
    ".env.example": "SECRET=\n",
    "node_modules/pkg/index.js": "ignored\n",
  });
  const manifest = await buildLocalManifest(root, fixtureManifestOptions());
  assert.equal(manifest.mode, "git");
  assert.ok(manifest.entries.has("src/index.ts"));
  assert.ok(manifest.entries.has("src/new file.ts"));
  assert.ok(manifest.entries.has(".env.example"));
  assert.equal(manifest.entries.has(".env"), false);
  assert.equal(manifest.entries.has("node_modules/pkg/index.js"), false);
});

test("filesystem fallback honors gitignore and rejects private key contents", async () => {
  const root = await createDirectoryFixture({
    ".gitignore": "cache/\n",
    "src/index.ts": "ok\n",
    "cache/data": "ignored\n",
    "secrets.txt": "-----BEGIN OPENSSH PRIVATE KEY-----\n",
  });
  await assert.rejects(buildLocalManifest(root, { ...fixtureManifestOptions(), git: unavailableGit() }), /private key.*secrets\.txt/i);
});
```

- [ ] **Step 3: Write failing safe-symlink and limits tests**

```ts
test("manifest accepts internal relative links and rejects escaping links", async () => {
  const root = await createSymlinkFixture();
  const manifest = await buildLocalManifest(root, fixtureManifestOptions());
  assert.deepEqual(manifest.entries.get("src/shared"), { type: "symlink", relativePath: "src/shared", target: "../packages/shared" });
  await replaceLink(root, "src/shared", "../../outside");
  await assert.rejects(buildLocalManifest(root, fixtureManifestOptions()), /escapes.*project root/i);
});
```

- [ ] **Step 4: Verify RED**

Run the manifest test; expect missing modules.

- [ ] **Step 5: Implement manifest builders**

Use `pi.exec`-compatible injected command runner for `git ls-files -z --cached --others --exclude-standard`; constrain results to mapping root. Use `lstat`, `readlink`, SHA-256 streaming, Git executable mode (`git ls-files -s -z`) and ordered `ignore` matchers. During fallback, recursively load applicable `.gitignore` files without following directory links. Enforce every resource limit before returning.

- [ ] **Step 6: Run focused tests, lint, and privacy**

```bash
node --import tsx --test --test-isolation=process tests/ssh-remote-manifest.test.ts
bun run lint
bun run check:privacy
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add package.json bun.lock extensions/ssh-remote/package.json extensions/ssh-remote/src/sync tests/ssh-remote-manifest.test.ts
git commit -m "feat(ssh-remote): build safe local mirror manifests"
```

---

### Task 6: Remote Mirror Adapter Primitives

**Files:**
- Modify: `extensions/ssh-remote/src/adapters/types.ts`
- Modify: `extensions/ssh-remote/src/adapters/unix.ts`
- Modify: `extensions/ssh-remote/src/adapters/windows.ts`
- Create: `extensions/ssh-remote/src/sync/remote-tree.ts`
- Test: `tests/ssh-remote-sync.test.ts`
- Modify: `package.json`

**Interfaces:**
- Extend `RemoteAdapter` with `realpathDirectory`, `inspectMirrorTree`, `readLink`, `writeFileAtomic`, `setExecutable`, `createSymlink`, `removeFile`, and `removeDirectory`.
- All methods take native paths converted through existing logical namespaces and optional AbortSignal.
- `inspectMirrorTree` returns files/directories/symlinks/other without following links.

- [ ] **Step 1: Register and write failing Unix/Windows primitive tests**

```ts
test("Unix mirror scan does not follow symlinks and atomic write uses a sibling temp", async () => {
  const executor = new ScriptRecordingExecutor();
  const adapter = new UnixBashAdapter(executor, "linux", "sh");
  await adapter.writeFileAtomic(toolPath(adapter, "/srv/test/project/src/index.ts"), Buffer.from("new"), false);
  assert.match(executor.commands.at(-1) ?? "", /\.pi-ssh-upload-/);
  assert.match(executor.commands.at(-1) ?? "", /mv/);
  assert.doesNotMatch(executor.commands.at(-1) ?? "", /sha256sum|find /);
});

test("Windows mirror delete treats a reparse point as a link", async () => {
  const executor = new PowerShellRecordingExecutor();
  const adapter = new WindowsPowerShellAdapter(executor, "pwsh", "linux");
  const tree = await adapter.inspectMirrorTree(toolPath(adapter, "C:\\Test\\Project"), [], undefined);
  assert.equal(tree.find((entry) => entry.relativePath === "linked")?.type, "symlink");
  assert.match(decodePowerShell(executor.commands[0]), /ReparsePoint/);
});
```

- [ ] **Step 2: Verify RED**

Expected: interface methods absent.

- [ ] **Step 3: Implement POSIX primitives**

Use one encoded POSIX `sh` control script per tree scan, shell quoting and NUL-framed metadata. Do not invoke remote `find` or hash tools. Recursively enumerate with shell globbing, lstat tests, and explicit depth/count bounds. Use sibling temporary files, `cat` stdin, `chmod`, and `mv`; remove links/files with `rm -f --`, empty directories with `rmdir --`.

- [ ] **Step 4: Implement PowerShell primitives**

Use existing UTF-16LE encoded PowerShell transport and Base64 path fields. Inspect `FileAttributes.ReparsePoint` before directory traversal. Use `[IO.File]`, `[IO.Directory]`, `Move-Item`, `Remove-Item -LiteralPath`, and `New-Item -ItemType SymbolicLink`; do not use remote hash commands.

- [ ] **Step 5: Run sync and existing adapter tests**

```bash
node --import tsx --test --test-isolation=process tests/ssh-remote-sync.test.ts tests/ssh-remote.test.ts tests/ssh-remote-windows-integration.test.ts
```

Expected: PASS (live Windows tests may skip without a host).

- [ ] **Step 6: Commit**

```bash
git add package.json extensions/ssh-remote/src/adapters extensions/ssh-remote/src/sync/remote-tree.ts tests/ssh-remote-sync.test.ts
git commit -m "feat(ssh-remote): add remote mirror filesystem primitives"
```

---

### Task 7: Marker Authorization and Dangerous-Root Validation

**Files:**
- Create: `extensions/ssh-remote/src/sync/marker.ts`
- Modify: `extensions/ssh-remote/src/sync/types.ts`
- Test: `tests/ssh-remote-sync.test.ts`

**Interfaces:**
- Produces `validateMirrorRoot(adapter, workspace, remoteRoot, signal)`.
- Produces `createAuthorizedMarker(candidate, userConfirmed, connection)` and `verifyAuthorizedMarker(mapping, connection)`.
- Produces `MirrorAuthorizationError` with stage and safe path details.

- [ ] **Step 1: Add failing zero-mutation and root tests**

```ts
test("marker mismatch performs zero remote mutations", async () => {
  const remote = fakeRemote({ marker: { markerId: "other" } });
  await assert.rejects(verifyAuthorizedMarker(fixtureMapping(), remote.connection), /markerId/);
  assert.deepEqual(remote.mutations, []);
});

test("dangerous Unix and Windows roots are rejected but safe children pass", async () => {
  await assert.rejects(validateMirrorRoot(unixAdapter(), unixWorkspace(), "/srv"), /dangerous mirror root/);
  await assert.doesNotReject(validateMirrorRoot(unixAdapter(), unixWorkspace(), "/srv/test/project"));
  await assert.rejects(validateMirrorRoot(windowsAdapter(), windowsWorkspace(), "C:\\Users\\deploy"), /profile/i);
  await assert.doesNotReject(validateMirrorRoot(windowsAdapter(), windowsWorkspace(), "C:\\Users\\deploy\\project"));
});
```

- [ ] **Step 2: Verify RED**

Expected: marker module missing.

- [ ] **Step 3: Implement validation and the one-time creation exception**

Canonicalize remote root through `realpathDirectory`; compare platform-aware dangerous roots and remote home/profile. Marker creation requires an explicit `userConfirmed: true`, validated writable directory, and no project content mutations before marker write. Existing marker must be a normal file and match version, markerId, mappingId, projectId, and canonical remoteRoot.

- [ ] **Step 4: Run focused tests**

Expected: PASS, including zero mutation assertions.

- [ ] **Step 5: Commit**

```bash
git add extensions/ssh-remote/src/sync/marker.ts extensions/ssh-remote/src/sync/types.ts tests/ssh-remote-sync.test.ts
git commit -m "feat(ssh-remote): authorize safe mirror roots with markers"
```

---

### Task 8: Strict Mirror Planner and Mutation Pass

**Files:**
- Create: `extensions/ssh-remote/src/sync/synchronizer.ts`
- Modify: `extensions/ssh-remote/src/sync/types.ts`
- Test: `tests/ssh-remote-sync.test.ts`

**Interfaces:**
- Produces `buildSyncPlan(local, remote, exclusions): SyncPlan`.
- Produces `applySyncPlan(snapshot, plan, signal, onProgress): Promise<SyncMutationSummary>`.
- `SyncSnapshot` captures mapping, server, local manifest, adapter/workspace, mapping generation, and local generation.

- [ ] **Step 1: Add failing plan tests**

```ts
test("strict plan uploads local changes, deletes remote extras, and preserves protected paths", () => {
  const plan = buildSyncPlan(localManifest([file("src/new.ts", "new")]), remoteTree([
    file("src/new.ts", "old"), file("src/stale.ts", "stale"), file(".env", "remote"), file("logs/app.log", "log"),
  ]), fixtureExclusions());
  assert.deepEqual(plan.uploadFiles, ["src/new.ts"]);
  assert.deepEqual(plan.deleteFiles, ["src/stale.ts"]);
  assert.ok(plan.protectedPaths.includes(".env"));
  assert.ok(plan.protectedPaths.includes("logs/app.log"));
});

test("type conflicts are removed before creating replacements", async () => {
  const remote = fakeRemoteTree({ "src/index.ts": { type: "directory" } });
  await applySyncPlan(fixtureSnapshot(fileManifest("src/index.ts", "content"), remote), buildFixturePlan(), undefined, () => {});
  assert.deepEqual(remote.operations.slice(0, 2).map((x) => x.kind), ["removeDirectory", "writeFileAtomic"]);
});
```

- [ ] **Step 2: Verify RED**

Expected: planner absent.

- [ ] **Step 3: Implement deterministic plan ordering**

Normalize all relative paths first. Reject `other` remote entries. Protect marker, protected descendants, and ancestors needed to retain protected descendants. Sort creates shallow-first and directory removals deep-first. Recheck marker immediately before mutation pass. Re-read each local file, reject type/hash changes, then use `writeFileAtomic`.

- [ ] **Step 4: Run focused tests**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extensions/ssh-remote/src/sync/synchronizer.ts extensions/ssh-remote/src/sync/types.ts tests/ssh-remote-sync.test.ts
git commit -m "feat(ssh-remote): apply strict local-authoritative mirror plans"
```

---

### Task 9: Full Verification, One Repair, and Final Barrier

**Files:**
- Create: `extensions/ssh-remote/src/sync/verifier.ts`
- Modify: `extensions/ssh-remote/src/sync/synchronizer.ts`
- Test: `tests/ssh-remote-sync.test.ts`

**Interfaces:**
- Produces `verifyRemoteMirror(snapshot, signal, onProgress): Promise<VerificationReport>`.
- Produces `synchronizeMirror(snapshot, signal, onProgress): Promise<SyncResult>` implementing mutate → verify → one repair → verify.
- `SyncResult.success` is possible only when snapshot generation remains current.

- [ ] **Step 1: Add failing same-size drift and persistent-writer tests**

```ts
test("verification repairs same-size remote drift and verifies again", async () => {
  const remote = fakeMutableRemote({ "src/index.ts": "bad!" });
  const result = await synchronizeMirror(fixtureSnapshot(fileManifest("src/index.ts", "good"), remote), undefined, () => {});
  assert.equal(result.result, "success");
  assert.equal(remote.readCount("src/index.ts"), 2);
  assert.equal(remote.content("src/index.ts"), "good");
});

test("second verification drift fails instead of looping", async () => {
  const remote = fakePersistentWriter("src/index.ts", ["bad1", "bad2", "bad3"]);
  await assert.rejects(synchronizeMirror(fixtureSnapshot(fileManifest("src/index.ts", "good"), remote), undefined, () => {}), /verification failed.*src\/index\.ts/i);
  assert.equal(remote.repairCount, 1);
});

test("stale local generation cannot report synchronized", async () => {
  const snapshot = fixtureSnapshot(fileManifest("src/index.ts", "good"), fakeRemote());
  snapshot.isGenerationCurrent = () => false;
  const result = await synchronizeMirror(snapshot, undefined, () => {});
  assert.equal(result.result, "stale");
});
```

- [ ] **Step 2: Verify RED**

Expected: verifier missing.

- [ ] **Step 3: Implement full local SHA-256 verification**

Re-scan remote path/type set, read every non-protected remote file through adapter, hash locally, compare symlink target and executable bit, and bound mismatch reporting. Build and apply at most one repair plan, then repeat complete verification. Never trust size or the prior sync manifest as proof.

- [ ] **Step 4: Run focused tests**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extensions/ssh-remote/src/sync/verifier.ts extensions/ssh-remote/src/sync/synchronizer.ts tests/ssh-remote-sync.test.ts
git commit -m "feat(ssh-remote): verify and repair remote mirror drift"
```

---

### Task 10: Debounced Watcher and Generation Queue

**Files:**
- Create: `extensions/ssh-remote/src/sync/queue.ts`
- Create: `extensions/ssh-remote/src/sync/watcher.ts`
- Test: `tests/ssh-remote-watcher.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces `MirrorQueue` with `markDirty(reason)`, `requestSync(request)`, `waitUntilSettled(signal)`, `pause()`, `resume()`, and `shutdown()`.
- Produces `createProjectWatcher(options)` with native recursive watcher and injectable polling fallback.
- Queue exposes immutable status snapshots for UI and a bounded `readonly SyncAuditRecord[]` containing timestamp, reason, generation, uploaded/deleted/protected path lists, verified count, result, and safe error text; it never stores file contents or credentials.
- Automatic connection failures use injected timers with retry delays exactly `[2000, 5000, 15000, 30000]` milliseconds, then wait for a file change, manual sync, connection test, or explicit network recovery request.

- [ ] **Step 1: Register and write failing deterministic-clock tests**

```ts
test("watcher debounce coalesces changes into one generation", async () => {
  const clock = new FakeClock();
  const syncs: number[] = [];
  const queue = createFixtureQueue({ clock, synchronize: async (generation) => { syncs.push(generation); return success(generation); } });
  queue.markDirty("file-change");
  clock.advance(1000);
  queue.markDirty("file-change");
  clock.advance(1499);
  assert.deepEqual(syncs, []);
  clock.advance(1);
  await queue.waitUntilSettled();
  assert.deepEqual(syncs, [2]);
});

test("changes during synchronization schedule exactly one follow-up", async () => {
  const gate = deferred<void>();
  const syncs: number[] = [];
  const queue = createFixtureQueue({ synchronize: async (generation) => { syncs.push(generation); if (syncs.length === 1) await gate.promise; return success(generation); } });
  const first = queue.requestSync({ reason: "startup", immediate: true });
  await nextTick();
  queue.markDirty("file-change"); queue.markDirty("file-change");
  gate.resolve();
  await first; await queue.waitUntilSettled();
  assert.deepEqual(syncs, [0, 2]);
});
```

- [ ] **Step 2: Add failing pause, retry, audit, shutdown, and polling fallback tests**

Assert paused queues do not sync; resume requests immediate full synchronization; connection failures schedule exactly 2000, 5000, 15000, and 30000 ms delays then stop; a new file change resets/wakes retry; audit history retains only the configured latest records and contains no file content; shutdown aborts timers and watcher once; native watcher errors activate one polling source with status `polling`.

- [ ] **Step 3: Verify RED**

Expected: queue/watcher modules absent.

- [ ] **Step 4: Implement serialized state machine**

Use injected clock/timer/watcher factories. A trigger-only watcher can increment generation while state remains initializing/failed. Synchronization completion publishes `synced` only when returned generation equals current generation. Abort is idempotent. Polling compares lightweight local manifest fingerprints but final sync always rebuilds full manifest. Classify only transport/connection failures as retryable; marker, dangerous-root, sensitive-file, resource-limit, and persistent-verification failures remain failed until an explicit change. Append a redacted `SyncAuditRecord` after every success, failure, stale result, or cancellation and retain the latest 20 records by default.

- [ ] **Step 5: Run focused tests without arbitrary sleeps**

```bash
node --import tsx --test --test-isolation=process tests/ssh-remote-watcher.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json extensions/ssh-remote/src/sync/queue.ts extensions/ssh-remote/src/sync/watcher.ts tests/ssh-remote-watcher.test.ts
git commit -m "feat(ssh-remote): watch and serialize local mirror changes"
```

---

### Task 11: Execution Policy, `ssh_sync`, `ssh_exec`, and Server Listing

**Files:**
- Create: `extensions/ssh-remote/src/exec/policy.ts`
- Create: `extensions/ssh-remote/src/exec/controller.ts`
- Create: `extensions/ssh-remote/src/exec/tools.ts`
- Modify: `extensions/ssh-remote/src/config.ts`
- Modify: `extensions/ssh-remote/src/settings.ts`
- Test: `tests/ssh-remote-exec.test.ts`
- Modify: `package.json`

**Interfaces:**
- Adds config `remoteExecutionTools`, `execConfirmation: "never" | "destructive" | "always"`, `execTimeoutSeconds` default 120, and optional `defaultServerId`.
- Produces `RemoteExecController.execute(request, ctx, signal, onUpdate)`.
- Produces `registerRemoteExecutionTools(pi, dependencies)` and `syncRemoteExecutionActiveTools(pi, state)`; the latter preserves unrelated tools while activating `ssh_list_servers`/`ssh_exec` only when servers exist and the feature is enabled, and activating `ssh_sync` only for a trusted mapped local workspace.

- [ ] **Step 1: Register and write failing target-resolution tests**

```ts
test("ssh_exec defaults to the current mapping server and remote root", async () => {
  const harness = createExecHarness({ mirrorState: "synced" });
  registerRemoteExecutionTools(harness.pi, harness.dependencies);
  const result = await harness.tools.get("ssh_exec").execute("exec-1", { command: "npm test" }, undefined, undefined, harness.ctx);
  assert.equal(harness.executions[0].server.name, "test-api");
  assert.equal(harness.executions[0].cwd, "/srv/test/project");
  assert.match(result.content[0].text, /Server: test-api/);
});

test("ssh_exec rejects ambiguous servers", async () => {
  const harness = createExecHarness({ mapping: undefined, servers: [fixtureServer("a"), fixtureServer("b")] });
  registerRemoteExecutionTools(harness.pi, harness.dependencies);
  await assert.rejects(harness.tools.get("ssh_exec").execute("exec-2", { command: "uptime" }, undefined, undefined, harness.ctx), /specify server.*ssh_list_servers/i);
});
```

- [ ] **Step 2: Add failing synchronization barrier tests**

```ts
test("ssh_exec waits for the latest mirror generation before executing", async () => {
  const harness = createExecHarness({ mirrorState: "dirty", generation: 4 });
  const running = harness.execute({ command: "npm test" });
  assert.equal(harness.executions.length, 0);
  harness.completeMirror(4);
  await running;
  assert.equal(harness.executions.length, 1);
});

test("ssh_exec blocks stale-code execution after mirror failure", async () => {
  const harness = createExecHarness({ mirrorState: "failed", mirrorError: "verification mismatch: src/index.ts" });
  await assert.rejects(harness.execute({ command: "npm test" }), /blocked.*verification mismatch/i);
  assert.equal(harness.executions.length, 0);
});

test("require_synced false allows diagnostics with a visible warning", async () => {
  const harness = createExecHarness({ mirrorState: "failed" });
  const result = await harness.execute({ command: "journalctl -u example-api", require_synced: false });
  assert.match(result.content[0].text, /Warning: current project mirror is not synchronized/);
});
```

- [ ] **Step 3: Add failing mode-isolation, active-tool, timeout, and truncation tests**

Assert tool execution never invokes workspace transition callbacks; a connection failure leaves full-workspace status untouched; server resolution honors `defaultServerId` before the single-server fallback; active-tool synchronization preserves unrelated built-ins/extensions and removes `ssh_sync` in full-remote or untrusted mode; AbortSignal reaches adapter; default timeout is 120; nonzero exit returns code/output; 60 KB output is tail-truncated with notice.

- [ ] **Step 4: Verify RED**

Expected: exec modules absent.

- [ ] **Step 5: Implement tools and controller**

Use TypeBox and `StringEnum` where enums are exposed. `ssh_sync` calls current `MirrorQueue.requestSync({ reason: "tool", immediate: true, force })`; reject in remote mode or untrusted/no mapping. `ssh_list_servers` returns non-sensitive metadata. Resolve server as explicit name → current mapping → configured `defaultServerId` → sole saved server → ambiguity error. `ssh_exec` uses the isolated pool, adapter shell, `truncateTail`, progress updates, and policy confirmation guarded by `ctx.hasUI`. Register all three tools once, then use `pi.getActiveTools()`/`pi.setActiveTools()` to preserve unrelated tools while applying state-dependent activation.

- [ ] **Step 6: Run focused tests, lint, and privacy**

```bash
node --import tsx --test --test-isolation=process tests/ssh-remote-exec.test.ts
bun run lint
bun run check:privacy
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add package.json extensions/ssh-remote/src/exec extensions/ssh-remote/src/config.ts extensions/ssh-remote/src/settings.ts tests/ssh-remote-exec.test.ts
git commit -m "feat(ssh-remote): add synchronized remote execution tools"
```

---

### Task 12: Integrate Mirror Lifecycle Without Changing Full-Workspace Routing

**Files:**
- Modify: `extensions/ssh-remote/src/extension.ts`
- Modify: `extensions/ssh-remote/index.ts`
- Create: `tests/ssh-remote-mode-integration.test.ts`
- Modify: `package.json`

**Interfaces:**
- Introduces an internal coordinator that derives `WorkspaceMode` from existing runtime state and owns optional active `MirrorQueue`.
- Registers management commands, `/ssh-sync`, tools, Footer `ssh-remote-mirror`, dynamic context, and cleanup.
- Existing remote runtime remains authoritative for built-in tool routing.

- [ ] **Step 1: Register and write failing local-mode isolation tests**

```ts
test("local synchronization and ssh_exec never reroute local file tools", async () => {
  const harness = createModeHarness({ workspace: "local", mapped: true });
  await harness.emit("session_start", { reason: "startup" });
  await harness.completeInitialSync();
  await harness.tools.get("ssh_exec").execute("exec", { command: "npm test" }, undefined, undefined, harness.ctx);
  const read = await harness.tools.get("read").execute("read", { path: "README.md" }, undefined, undefined, harness.ctx);
  assert.match(read.content[0].text, /local fixture/);
  assert.equal(harness.remoteFileReads, 0);
  assert.equal(harness.statuses.has("ssh-remote"), false);
});

test("independent server failure does not set full SSH disconnected", async () => {
  const harness = createModeHarness({ workspace: "local", mapped: true, execFailure: "connection refused" });
  await assert.rejects(harness.executeRemote("uptime"), /connection refused/);
  assert.equal(harness.statuses.has("ssh-remote"), false);
  assert.equal(harness.mirrorState(), "synced");
});
```

- [ ] **Step 2: Add failing `/ssh-connect` pause and `/ssh-exit` resume tests**

```ts
test("full SSH transition pauses mirror and exit performs a fresh full sync", async () => {
  const harness = createModeHarness({ workspace: "local", mapped: true });
  await harness.emit("session_start", { reason: "startup" });
  await harness.commands.get("ssh-connect").handler("devbox:/srv/project", harness.ctx);
  assert.equal(harness.mirrorState(), "paused");
  assert.equal(harness.watcherActive(), false);
  await harness.commands.get("ssh-exit").handler("", harness.ctx);
  await harness.waitForMirror();
  assert.equal(harness.fullSyncReasons.at(-1), "ssh-exit");
  assert.equal(harness.watcherActive(), true);
});
```

- [ ] **Step 3: Add failing trust, reload, shutdown, tree, and remote-disconnect tests**

Assert `ctx.isProjectTrusted() === false` prevents initial sync, watcher creation, `ssh_sync`, and mapping-driven `ssh_exec` before any connection acquisition; reload closes old watcher exactly once and new instance starts a full sync; repeated `session_shutdown` clears debounce/retry/poll timers, watcher, queue, Footer status, and isolated pool exactly once; tree restoration does not read mirror state as session SSH state; existing full-remote disconnect still blocks read without local fallback.

- [ ] **Step 4: Verify RED**

Expected: coordinator integration absent.

- [ ] **Step 5: Implement lifecycle coordinator in small extracted helpers**

Do not rewrite existing routing. Hook after existing `session_start` intent resolution and first gate on `ctx.isProjectTrusted()`: trusted local mode starts trigger-only watcher and initial queue; untrusted local mode records a disabled status without acquiring a server connection; remote mode marks mirror paused. Before command-based full transition call `pause()`. After successful `disconnect()` call local mirror resume only when the replacement local context is trusted. Merge cleanup into one idempotent mirror/pool shutdown path so every resource closes exactly once.

- [ ] **Step 6: Add dynamic context and statuses**

Use hidden custom context separate from `ssh-remote-environment`; remove prior mirror context before appending current. In local mapped mode say file tools are local, watcher syncs, and Agent should use `ssh_exec` for real execution. In full remote mode say mirror paused and `ssh_sync` unavailable. Use Footer key `ssh-remote-mirror`, never the existing `ssh-remote` key. On every `session_shutdown`, clear `ssh-remote-mirror` and remove all session-scoped references before awaiting the idempotent coordinator shutdown.

- [ ] **Step 7: Run focused plus full existing SSH suite**

```bash
node --import tsx --test --test-isolation=process tests/ssh-remote-mode-integration.test.ts tests/ssh-remote.test.ts tests/ssh-remote-windows-integration.test.ts
```

Expected: PASS; optional live Windows tests may skip.

- [ ] **Step 8: Commit**

```bash
git add package.json extensions/ssh-remote/src/extension.ts extensions/ssh-remote/index.ts tests/ssh-remote-mode-integration.test.ts
git commit -m "feat(ssh-remote): integrate local mirror lifecycle safely"
```

---

### Task 13: Full Management Authorization and Status UX

**Files:**
- Modify: `extensions/ssh-remote/src/servers/commands.ts`
- Modify: `extensions/ssh-remote/src/extension.ts`
- Modify: `extensions/ssh-remote/src/settings.ts`
- Test: `tests/ssh-remote-mappings.test.ts`
- Test: `tests/ssh-remote-mode-integration.test.ts`

**Interfaces:**
- Completes `/ssh map add|edit|rm|pause|resume`, `/ssh sync`, `/ssh-sync`, and expanded `/ssh-status`.
- Mapping creation receives sync preview from synchronizer dry-run, one user confirmation, marker creation, transactional save, initial sync, then watcher activation.

- [ ] **Step 1: Add failing first-authorization tests**

```ts
test("mapping authorization previews destructive mirror work before marker creation", async () => {
  const harness = createMappingCommandHarness({ confirm: false, preview: { upload: 3, delete: 2, protected: 1 } });
  await harness.run("map add");
  assert.match(harness.confirmations[0].message, /upload.*3.*delete.*2.*protected.*1/is);
  assert.equal(harness.markerWrites, 0);
  assert.equal(harness.projectMutations, 0);
  assert.equal(harness.mappingCount, 0);
});
```

- [ ] **Step 2: Add failing protection-expansion and transactional target tests**

Assert adding protections needs no destructive reauthorization, removing one requires new preview/confirmation, and failed new-target marker/sync leaves old mapping and watcher active.

- [ ] **Step 3: Add failing status tests**

Assert `/ssh-status` renders local unconfigured, initializing, syncing, synced, failed, untrusted, and full-remote/paused forms without confusing `Mirror:` and `SSH:`.

- [ ] **Step 4: Verify RED**

Expected: incomplete command flows/status.

- [ ] **Step 5: Implement authorization and status flows**

Ensure command handlers call `ctx.waitForIdle()` before mapping/sync transitions. Marker remains on remote after local mapping removal. `resume` always requests immediate full synchronization before reporting active watcher. Headless flows requiring confirmation refuse safely.

- [ ] **Step 6: Run focused tests**

```bash
node --import tsx --test --test-isolation=process tests/ssh-remote-mappings.test.ts tests/ssh-remote-mode-integration.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add extensions/ssh-remote/src/servers/commands.ts extensions/ssh-remote/src/extension.ts extensions/ssh-remote/src/settings.ts tests/ssh-remote-mappings.test.ts tests/ssh-remote-mode-integration.test.ts
git commit -m "feat(ssh-remote): complete mirror authorization and status UX"
```

---

### Task 14: Real SSH Integration Coverage and Resource Hardening

**Files:**
- Modify: `tests/ssh-remote.test.ts`
- Modify: `tests/ssh-remote-windows-integration.test.ts`
- Modify: `tests/README.md`

**Interfaces:**
- No new public interfaces; validates real adapters and transport lifecycle.

- [ ] **Step 1: Add a localhost Unix mirror integration test**

Create a temporary local Git project and remote scratch directory under a documentation-safe fixture root. Authorize marker, sync source plus `.env.example`, retain remote `.env` and `logs/app.log`, delete remote stale source, mutate a same-size remote source file, resync, and assert exact repair. Skip when key-authenticated localhost SSH is unavailable.

- [ ] **Step 2: Run it before any test-specific production adjustment**

```bash
node --import tsx --test --test-isolation=process --test-name-pattern="real localhost mirror" tests/ssh-remote.test.ts
```

Expected: PASS because Tasks 6–13 already provide the adapter, synchronizer, verifier, queue, and lifecycle behavior exercised by this integration test. Any failure starts a new focused red-green correction against the production module named in the stack trace; do not weaken the integration assertion.

- [ ] **Step 3: Extend live Windows integration**

Add tests under `PI_SSH_TEST_HOST` for atomic replacement, Unicode strict deletion, protected `.env`, full remote-content verification, and symlink creation success or an explicit permission failure. Keep automatic skip without a host.

- [ ] **Step 4: Run integration suites and privacy scan**

```bash
bun run check:privacy
node --import tsx --test --test-isolation=process tests/ssh-remote.test.ts tests/ssh-remote-windows-integration.test.ts
```

Expected: PASS with environment-dependent skips only.

- [ ] **Step 5: Commit**

```bash
git add tests/ssh-remote.test.ts tests/ssh-remote-windows-integration.test.ts tests/README.md
git commit -m "test(ssh-remote): cover real strict mirror behavior"
```

---

### Task 15: Documentation, Package Contract, and Final Verification

**Files:**
- Modify: `extensions/ssh-remote/README.md`
- Modify: `README.md`
- Modify: `tests/README.md`
- Modify: `extensions/ssh-remote/package.json` only if dependency/file metadata must change for the staged package; do not change the package version in this task

**Interfaces:**
- Documents the final user contract; no new runtime API.

- [ ] **Step 1: Update package README**

Document:

- Local development versus full remote workspace mode.
- `/ssh` management and every subcommand.
- Project mapping authorization, marker, dangerous-root rules, strict deletion, default protected paths, automatic initial sync, watcher debounce, manual `/ssh-sync`.
- `ssh_exec`, `ssh_sync`, `ssh_list_servers`, `require_synced: false`, confirmation policy, and no-extra-remote-tools guarantee.
- Failure recovery, Footer states, Unix/Windows symlink limits, complete remote verification cost, and privacy/security behavior.

Use only fictional examples such as `/local/workspace`, `test-api`, `deploy@devbox`, `/srv/test/project`, and `C:\\Users\\deploy\\test-project`.

- [ ] **Step 2: Update root and test documentation**

Add concise feature summary to root README and explain unit/live integration coverage in `tests/README.md`. Do not restore deleted E2E scripts or links.

- [ ] **Step 3: Run complete verification**

```bash
bun install --frozen-lockfile
bun run check
bun run pack:ssh-remote
```

Expected:

- privacy scan passes;
- TypeScript strict check passes;
- all configured tests pass with only documented unavailable-host skips;
- build creates `dist/ssh-remote/index.min.js` and `index.min.js.map`;
- pack dry-run includes README, LICENSE, package manifest, minified entry, source map, and runtime `ignore`/`ssh2` dependencies as intended.

- [ ] **Step 4: Inspect staged package contract**

```bash
node -e '
const fs = require("node:fs");
const p = JSON.parse(fs.readFileSync("dist/ssh-remote/package.json", "utf8"));
if (p.pi.extensions[0] !== "./index.min.js") process.exit(1);
if (!p.dependencies.ignore || !p.dependencies.ssh2) process.exit(1);
console.log(p.name, p.version, p.pi.extensions[0]);
'
```

Expected: package name/version and `./index.min.js`, exit 0.

- [ ] **Step 5: Request code review**

Use the `requesting-code-review` skill. Review specifically against the spec’s mode isolation, zero-mutation marker failure, strict remote deletion, protected-path ancestry, full-content verification, and credential non-disclosure requirements.

- [ ] **Step 6: Commit documentation and final adjustments**

```bash
git add extensions/ssh-remote/README.md README.md tests/README.md extensions/ssh-remote/package.json bun.lock
git commit -m "docs(ssh-remote): document local mirror remote execution workflow"
```

---

## Execution Checkpoints

- **Checkpoint A — after Task 4:** Server/mapping management works but no remote mutation exists. Review config and UI contracts.
- **Checkpoint B — after Task 9:** Manual strict mirror is complete and independently testable. Security review marker/path/deletion logic before enabling watchers.
- **Checkpoint C — after Task 10:** Automatic synchronization works, but `ssh_exec` is not exposed yet. Review queue lifecycle and network behavior.
- **Checkpoint D — after Task 13:** Full feature is integrated. Run all existing SSH tests before live integration/docs.
- **Checkpoint E — after Task 15:** Full verification and package review complete; use branch-finishing workflow.
