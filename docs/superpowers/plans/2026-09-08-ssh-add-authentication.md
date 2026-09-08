# SSH Add Authentication and Chinese UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 `/ssh add` 增加安全的密码/托管私钥认证配置，并将 SSH Remote 插件全部用户可见界面文字改为中文。

**Architecture:** 认证偏好作为 `SavedSshServer` 的非敏感元数据向连接池和 OpenSSH/ssh2 传输层传递；密码继续由现有 `SshPasswordResolver` 管理，私钥由独立的小型托管文件模块原子写入 Pi SSH 目录。中文界面直接替换用户可见字符串，技术 ID、枚举值和原始底层诊断保持不变，不引入 i18n 框架。

**Tech Stack:** TypeScript strict mode、Node.js 标准库、Pi Extension API、OpenSSH、ssh2、Node test runner、Bun 1.3.14。

**Spec:** `docs/superpowers/specs/2026-09-08-ssh-add-authentication-design.md`

## Global Constraints

- 默认 OpenSSH 配置路径必须通过 `join(getAgentDir(), "ssh", "config")` 计算，禁止硬编码 `/home/node`。
- 私钥仅能写入 `<getAgentDir()>/ssh/<文件名>`，目录 `0700`、文件 `0600`。
- 密码和私钥内容不得进入服务器 JSON、日志、通知、错误文本或测试快照。
- 私钥文件名只允许 `[A-Za-z0-9._-]+`，并拒绝 `.`、`..`、路径分隔符、控制字符和目录逃逸。
- 私钥最大 1 MiB；拒绝公钥、证书、无效私钥和加密私钥。
- 不新增依赖，不实现 passphrase、OAuth、Token、Git remote 或 push 管理。
- 旧服务器记录缺少认证字段时必须保持兼容并规范化为 `auto`。
- 命令 ID、工具 ID、事件名、JSON 字段名、Shell/传输枚举和 OpenSSH 技术标识保持英文。
- 用户可见弹框、通知、设置、状态和插件错误上下文统一为中文；原始 SSH/OS 诊断原样附后。
- 所有测试、构建和类型检查只在 Docker 执行环境运行，不在 Pi Kubernetes 工作区执行。

---

### Task 1: 服务器认证模型与 OpenSSH 参数

**Files:**
- Modify: `extensions/ssh-remote/src/servers/types.ts`
- Modify: `extensions/ssh-remote/src/servers/store.ts`
- Modify: `extensions/ssh-remote/src/transport/client.ts`
- Test: `tests/ssh-remote-servers.test.ts`
- Test: `tests/ssh-remote.test.ts`

**Interfaces:**
- Produces: `SshAuthenticationPreference = "auto" | "password" | "key"`
- Produces: `SavedSshServer.authenticationPreference` and optional `SavedSshServer.identityFile`
- Produces: matching optional fields on `SshClientOptions`
- Consumes: existing `normalizeServerStore()` and `buildSshArguments()`

- [ ] **Step 1: Write failing compatibility and serialization tests**

Add tests asserting:

```ts
const legacy = normalizeServerStore({ version: 1, servers: [{
  ...fixtureServer(),
  authenticationPreference: undefined,
}] });
assert.equal(legacy.servers[0].authenticationPreference, "auto");
assert.equal(legacy.servers[0].identityFile, undefined);

assert.throws(() => normalizeServerStore({ version: 1, servers: [{
  ...fixtureServer(), authenticationPreference: "key",
}] }), /identity/i);
```

Also assert password-shaped and private-key-content fields are dropped from serialized output.

- [ ] **Step 2: Run focused tests in Docker and verify RED**

Run the uploaded project in the Bun 1.3.14 execution container:

```bash
bun run build:packages
node --import tsx --test --test-name-pattern='server store|SSH arguments' tests/ssh-remote-servers.test.ts tests/ssh-remote.test.ts
```

Expected: FAIL because authentication fields and argument ordering do not exist.

- [ ] **Step 3: Implement the minimal model normalization**

Add:

```ts
export type SshAuthenticationPreference = "auto" | "password" | "key";
```

Normalize missing values to `auto`; require an absolute, control-character-free `identityFile` only for `key`; omit it for other modes. Preserve store version 1.

- [ ] **Step 4: Implement OpenSSH argument ordering**

Extend `SshClientOptions` and `buildSshArguments()`:

```ts
if (options.authenticationPreference === "key") {
  args.push("-i", options.identityFile!, "-o", "IdentitiesOnly=no");
}
if (options.authenticationPreference === "password") {
  args.push("-o", "PreferredAuthentications=password,keyboard-interactive,publickey");
} else if (options.authenticationPreference === "key") {
  args.push("-o", "PreferredAuthentications=publickey,password,keyboard-interactive");
}
```

Validate the key mode before spawning.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the same focused command. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add extensions/ssh-remote/src/servers/types.ts extensions/ssh-remote/src/servers/store.ts extensions/ssh-remote/src/transport/client.ts tests/ssh-remote-servers.test.ts tests/ssh-remote.test.ts
git commit -m "feat(ssh): persist server authentication preference"
```

---

### Task 2: 托管私钥文件事务

**Files:**
- Create: `extensions/ssh-remote/src/servers/managed-key.ts`
- Test: `tests/ssh-remote-managed-key.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `getManagedSshDirectory(): string`
- Produces: `getDefaultOpenSshConfigPath(): string`
- Produces: `validateManagedKeyName(name: string): string`
- Produces: `validatePrivateKey(contents: string): Promise<void>`
- Produces: `stageManagedKey(name: string, contents: string): Promise<ManagedKeyTransaction>`
- Produces: `ManagedKeyTransaction` with `path`, `existed`, `commit()` and `rollback()`

- [ ] **Step 1: Write failing managed-key tests**

Cover:

```ts
assert.equal(validateManagedKeyName("id_ed25519_test"), "id_ed25519_test");
for (const bad of ["", ".", "..", "../key", "a/b", "a\\b", "a\nkey"]) {
  assert.throws(() => validateManagedKeyName(bad));
}
```

Generate a temporary test-only key at runtime with `generateKeyPairSync()` and export it as unencrypted PKCS#8; do not commit key fixtures. Stage it, assert directory mode `0700`, file mode `0600`, then verify `rollback()` deletes a new file and restores an overwritten file byte-for-byte. Assert encrypted, public, invalid and >1 MiB inputs fail without including input contents in errors.

- [ ] **Step 2: Run the new test and verify RED**

```bash
node --import tsx --test tests/ssh-remote-managed-key.test.ts
```

Expected: FAIL because `managed-key.ts` does not exist.

- [ ] **Step 3: Implement minimal validation and transactional write**

Use `ssh2.utils.parseKey()` for OpenSSH and PEM formats; accept only parsed keys whose `isPrivateKey()` is true. Map encrypted/passphrase parse errors to the approved encrypted-key message and all other parse errors to a generic invalid-key message. Never include key contents in errors.

`stageManagedKey()` must reject symlink/non-file targets, capture prior bytes and mode in memory, atomically publish the new file, and make `rollback()` idempotent.

- [ ] **Step 4: Run managed-key tests and verify GREEN**

```bash
node --import tsx --test tests/ssh-remote-managed-key.test.ts
```

Expected: PASS.

- [ ] **Step 5: Add the test to the root test script and commit**

```bash
git add extensions/ssh-remote/src/servers/managed-key.ts tests/ssh-remote-managed-key.test.ts package.json
git commit -m "feat(ssh): add transactional managed private keys"
```

---

### Task 3: 密码预置与连接池认证传递

**Files:**
- Modify: `extensions/ssh-remote/src/transport/password-resolver.ts`
- Modify: `extensions/ssh-remote/src/servers/connection-pool.ts`
- Modify: `extensions/ssh-remote/src/transport/index.ts`
- Test: `tests/ssh-remote-servers.test.ts`
- Test: `tests/ssh-remote.test.ts`

**Interfaces:**
- Produces: `SshPasswordResolver.rememberPassword(endpoint, password): void`
- Produces: `ServerConnectionPool.rememberPassword(server, password): Promise<void>`
- Consumes: `SavedSshServer.authenticationPreference`, `identityFile`

- [ ] **Step 1: Write failing password tests**

Assert `rememberPassword()` stores only in memory when persistence is off, writes the endpoint key to the `0600` secrets file when on, and rejects empty passwords. Assert the server JSON remains free of password values.

Add a pool test asserting client creation receives:

```ts
{
  authenticationPreference: "password",
  identityFile: undefined,
}
```

and key servers receive their explicit identity path.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
node --import tsx --test --test-name-pattern='remember password|server pool authentication' tests/ssh-remote-servers.test.ts tests/ssh-remote.test.ts
```

Expected: FAIL because the methods and option propagation are absent.

- [ ] **Step 3: Implement password preloading and option propagation**

Add one validated resolver method reusing current memory/secrets writes. In the pool, resolve and remember the raw OpenSSH endpoint used by current password fallback, and also the effective ssh2 endpoint when available so aliases work across transports. Resolution failure must not expose the password and must leave the raw endpoint usable.

Pass authentication preference and identity path to every saved-server client.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the same focused command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extensions/ssh-remote/src/transport/password-resolver.ts extensions/ssh-remote/src/servers/connection-pool.ts extensions/ssh-remote/src/transport/index.ts tests/ssh-remote-servers.test.ts tests/ssh-remote.test.ts
git commit -m "feat(ssh): preload selected password authentication"
```

---

### Task 4: ssh2 显式密钥与认证顺序

**Files:**
- Modify: `extensions/ssh-remote/src/transport/ssh2-config.ts`
- Test: `tests/ssh-remote.test.ts`

**Interfaces:**
- Consumes: `SshClientOptions.authenticationPreference`, `identityFile`
- Produces: ordered ssh2 `AnyAuthMethod[]` honoring password/key/auto preference

- [ ] **Step 1: Write failing ssh2 authentication-order tests**

Use temporary generated keys and fake OpenSSH config resolution. Assert:

```text
password: none → password → configured keys/agent
key: none → explicit identity → configured keys/agent → password
legacy auto: none → configured keys/agent → password
```

Assert unreadable or encrypted explicit identities fail with a bounded message containing the path but not key contents.

- [ ] **Step 2: Run focused test and verify RED**

```bash
node --import tsx --test --test-name-pattern='ssh2 authentication preference' tests/ssh-remote.test.ts
```

Expected: FAIL because ssh2 ignores explicit server authentication preference.

- [ ] **Step 3: Implement ordered authentication construction**

Pass `SshClientOptions` into `buildAuthentication()`, load the explicit identity first in key mode, deduplicate it from OpenSSH `IdentityFile` entries, and reorder password/agent/key methods without changing host verification or ProxyJump behavior.

- [ ] **Step 4: Run focused and transport regression tests**

```bash
node --import tsx --test --test-name-pattern='ssh2 authentication preference|ProxyJump|password authentication|host key' tests/ssh-remote.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extensions/ssh-remote/src/transport/ssh2-config.ts tests/ssh-remote.test.ts
git commit -m "feat(ssh): honor authentication preference in ssh2"
```

---

### Task 5: `/ssh add`、编辑和删除认证流程

**Files:**
- Modify: `extensions/ssh-remote/src/servers/commands.ts`
- Modify: `extensions/ssh-remote/src/extension.ts`
- Test: `tests/ssh-remote-servers.test.ts`
- Test: `tests/ssh-remote-mode-integration.test.ts`

**Interfaces:**
- Consumes: managed-key transaction API from Task 2
- Consumes: pool password preload API from Task 3
- Produces: interactive add/edit/remove workflows with rollback

- [ ] **Step 1: Write failing command-flow tests**

Register commands against a fake Pi API/UI and assert the exact prompt sequence. For add, verify the config input placeholder equals the computed persistent path and authentication labels are `密码认证` and `密钥认证`.

Password path: assert the entered password is sent only to the resolver/pool and the saved server contains `authenticationPreference: "password"`.

Key path: assert `ctx.ui.editor("粘贴私钥", "")` is used, overwrite requires confirmation, connection failure calls rollback, success calls commit, and saved server contains only `identityFile`.

- [ ] **Step 2: Run command-flow tests and verify RED**

```bash
node --import tsx --test tests/ssh-remote-servers.test.ts tests/ssh-remote-mode-integration.test.ts
```

Expected: FAIL on prompt sequence and missing authentication behavior.

- [ ] **Step 3: Implement add workflow**

Use `getDefaultOpenSshConfigPath()` as the visible default. Keep one local `ManagedKeyTransaction | undefined`; wrap test plus store update in `try/catch`, call `commit()` only after server persistence, and `rollback()` for every failure/cancellation after staging.

- [ ] **Step 4: Implement edit and delete workflow**

Editing must never read an existing private key into UI. Provide Chinese choices to keep current key, replace it, or switch to password. Deleting asks to remove an unshared managed key; shared keys and files outside the managed directory are preserved.

- [ ] **Step 5: Run command and mode tests and verify GREEN**

Run the same command. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add extensions/ssh-remote/src/servers/commands.ts extensions/ssh-remote/src/extension.ts tests/ssh-remote-servers.test.ts tests/ssh-remote-mode-integration.test.ts
git commit -m "feat(ssh): configure authentication in server dialogs"
```

---

### Task 6: SSH Remote 全部用户界面中文化

**Files:**
- Modify: `extensions/ssh-remote/src/extension.ts`
- Modify: `extensions/ssh-remote/src/settings.ts`
- Modify: `extensions/ssh-remote/src/config.ts`
- Modify: `extensions/ssh-remote/src/servers/commands.ts`
- Modify: `extensions/ssh-remote/src/exec/controller.ts`
- Modify: `extensions/ssh-remote/src/exec/tools.ts`
- Modify: `extensions/ssh-remote/src/sync/controller.ts`
- Modify: `extensions/ssh-remote/src/sync/queue.ts`
- Modify: relevant files under `extensions/ssh-remote/src/adapters/`, `transport/`, `workspace/`, `background/`, and `resources/` only where strings are user-visible
- Test: `tests/ssh-remote-ui-zh.test.ts`
- Modify: `package.json`

**Interfaces:**
- Preserves: all command/tool/event/config identifiers and enum values
- Produces: Chinese user-facing text with unchanged raw diagnostics appended

- [ ] **Step 1: Write failing Chinese UI contract test**

Create a focused test that exercises command menus, settings rows, connection failure, mapping confirmation, password prompt and tool responses. Assert Chinese labels are present and stable technical IDs remain unchanged:

```ts
assert.equal(tool.name, "ssh_exec");
assert.match(promptTitle, /SSH 密码/);
assert.match(errorText, /^SSH 连接失败：/);
assert.match(errorText, /Permission denied \(publickey,password\)/);
```

Add a source-level allowlist scan limited to user-facing API calls (`ui.input/select/confirm/editor/notify/setStatus`, setting labels/descriptions, registered tool descriptions) to catch remaining all-English prose while excluding raw diagnostics and protocol constants.

- [ ] **Step 2: Run Chinese UI tests and verify RED**

```bash
node --import tsx --test tests/ssh-remote-ui-zh.test.ts
```

Expected: FAIL because existing UI is English.

- [ ] **Step 3: Translate command, settings and status UI**

Translate visible labels and descriptions directly. Keep display mappings separate from persisted enum values, for example:

```ts
const TRANSPORT_LABELS = {
  auto: "auto（自动）",
  openssh: "openssh（系统 OpenSSH）",
  ssh2: "ssh2（内置连接）",
} as const;
```

Reverse-map selected labels to existing enum values.

- [ ] **Step 4: Translate remaining user-visible plugin output**

Translate plugin-created context, notifications, tool summaries and error prefixes. Preserve raw external stderr/message text after a Chinese prefix and do not translate paths, hosts or commands.

- [ ] **Step 5: Run Chinese UI and legacy regression tests**

```bash
node --import tsx --test tests/ssh-remote-ui-zh.test.ts tests/ssh-remote-servers.test.ts tests/ssh-remote-mode-integration.test.ts tests/ssh-remote.test.ts tests/ssh-remote-windows-integration.test.ts
```

Expected: PASS after updating assertions that intentionally inspect user-visible text; technical-ID assertions remain unchanged.

- [ ] **Step 6: Commit**

```bash
git add extensions/ssh-remote/src tests/ssh-remote-ui-zh.test.ts tests/ssh-remote-servers.test.ts tests/ssh-remote-mode-integration.test.ts tests/ssh-remote.test.ts tests/ssh-remote-windows-integration.test.ts package.json
git commit -m "feat(ssh): localize user interface in Chinese"
```

---

### Task 7: 文档、隐私检查和完整验证

**Files:**
- Modify: `extensions/ssh-remote/README.md`
- Modify: `tests/README.md`
- Modify: `README.md` only if its SSH section describes the old flow
- Modify: `scripts/check-test-privacy.ts` only if the new test must be registered

**Interfaces:**
- Documents: final `/ssh add` flow, storage, rollback, unsupported encrypted keys and Chinese UI boundary

- [ ] **Step 1: Update documentation**

Document the visible default config path as `<PI_CODING_AGENT_DIR>/ssh/config`, password persistence behavior, managed-key directory/modes, overwrite and deletion behavior, encrypted-key rejection, and the fact that GitLab/GitHub Git endpoints do not provide a normal remote shell.

- [ ] **Step 2: Run static safety checks in Docker**

```bash
bun run check:privacy
git diff --check
rg -n 'password\s*[:=]|privateKey\s*[:=]|BEGIN .*PRIVATE KEY' tests/ssh-remote-*.test.ts
```

Expected: privacy check and diff check pass; any pattern matches are fixed test-only constructions that do not contain credentials or real key fixtures.

- [ ] **Step 3: Run full project verification in Docker**

```bash
bun install --frozen-lockfile
bun run check
bun run pack:ssh-remote
```

Expected: all type checks, tests, builds and package dry-run pass; `dist/ssh-remote/index.min.js` and linked source map are present in the execution container.

- [ ] **Step 4: Verify repository state and commit docs**

```bash
git status --short
git diff --check
git add README.md extensions/ssh-remote/README.md tests/README.md scripts/check-test-privacy.ts docs/superpowers/specs/2026-09-08-ssh-add-authentication-design.md docs/superpowers/plans/2026-09-08-ssh-add-authentication.md
git commit -m "docs(ssh): document managed authentication setup"
```

- [ ] **Step 5: Request code review**

Use the requesting-code-review workflow against the complete feature branch, fix correctness/security findings, and rerun `bun run check` plus `bun run pack:ssh-remote` before presenting integration options.
