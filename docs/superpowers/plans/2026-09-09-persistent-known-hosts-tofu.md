# Persistent known_hosts TOFU Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 SSH Remote 在容器重启后使用 Pi 配置目录中的持久 known_hosts，并对首次未知主机显示中文 SHA-256 指纹确认。

**Architecture:** 新增 host-trust 小模块负责候选、指纹、持久 store 和异步确认循环。ssh2 在同步 `hostVerifier` 中只捕获候选并失败关闭；saved-server pool 与完整远程连接在上层捕获候选、确认、写入并重试。OpenSSH 正式连接前使用相同 ssh2 配置解析与 host-key 验证预检，正式命令始终显式启用严格 persistent known_hosts。

**Tech Stack:** TypeScript strict mode、Node.js 标准库、Pi Extension API、OpenSSH、ssh2、Node 24 test runner、Bun 1.3.14。

**Spec:** `docs/superpowers/specs/2026-09-09-persistent-known-hosts-tofu-design.md`

## Global Constraints

- 持久路径必须是 `join(getAgentDir(), "ssh", "known_hosts")`，禁止硬编码 home。
- 禁止 `StrictHostKeyChecking=no`、`accept-new`、静默信任或冲突自动覆盖。
- 未知 key 必须在用户认证前停止当前尝试；无 UI 时失败关闭。
- 指纹变化和 `@revoked` 不显示信任确认，直接拒绝。
- 目录 `0700`、文件 `0600`；符号链接和特殊文件拒绝。
- known_hosts 最大 16 MiB，写入同目录临时文件、fsync、原子 rename。
- 技术标识保持英文，新增用户界面使用中文。
- 不新增依赖，不调用 ssh-keyscan。
- 测试与构建只在 Docker 中执行。

---

### Task 1: Host key 候选与持久 store

**Files:**
- Create: `extensions/ssh-remote/src/host-trust/types.ts`
- Create: `extensions/ssh-remote/src/host-trust/store.ts`
- Create: `extensions/ssh-remote/src/host-trust/index.ts`
- Create: `tests/ssh-remote-host-trust.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `SshHostKeyCandidate`, `UnknownSshHostKeyError`, `ChangedSshHostKeyError`
- Produces: `parseSshHostKeyBlob(key, endpoint): SshHostKeyCandidate`
- Produces: `getPersistentKnownHostsPath(agentDir?): string`
- Produces: `trustHostKey(candidate, path?): void`

- [ ] Write failing tests for blob algorithm parsing, SHA-256 fingerprint, host vs `[host]:port`, default path, 0700/0600 modes, idempotent append, comments preservation, symlink rejection, conflict rejection and 16 MiB limit.
- [ ] Run `node --import tsx --test tests/ssh-remote-host-trust.test.ts` in Docker; expect module-not-found RED.
- [ ] Implement minimum store with `ssh2.utils.parseKey()`/binary SSH string parsing, `createHash("sha256")`, `lstat`, bounded read, same-directory temporary file, `fsyncSync`, rename and cleanup.
- [ ] Run the test; expect GREEN.
- [ ] Add the test to root `test` script and commit `feat(ssh): add persistent host trust store`.

### Task 2: ssh2 未知、冲突和 revoked 捕获

**Files:**
- Modify: `extensions/ssh-remote/src/transport/ssh2-config.ts`
- Modify: `extensions/ssh-remote/src/transport/ssh2-client.ts`
- Modify: `extensions/ssh-remote/src/transport/index.ts`
- Test: `tests/ssh-remote-host-trust.test.ts`
- Test: `tests/ssh-remote.test.ts`

**Interfaces:**
- `Ssh2ConfigResolverOptions.knownHostsFiles?: readonly string[]`
- `ResolvedSsh2Endpoint.verification` adds `candidate?: SshHostKeyCandidate`, `kind?: "unknown" | "changed" | "revoked"`
- `Ssh2Client` throws typed host-trust errors with candidate data.

- [ ] Write failing resolver/client tests: known match succeeds; no record throws unknown candidate; existing mismatch throws changed; revoked throws changed/revoked; candidate appears before auth prompt.
- [ ] Run focused tests and verify RED.
- [ ] Restrict trust reads to persistent path plus `/etc/ssh/ssh_known_hosts`; allow zero known keys so `hostVerifier` can capture candidate; distinguish unknown from changed/revoked; preserve candidate through `Ssh2ConnectionError`.
- [ ] Run focused host verification, password and ProxyJump regressions; expect GREEN.
- [ ] Commit `feat(ssh): surface unknown host keys from ssh2`.

### Task 3: 中文确认控制器与并发去重

**Files:**
- Create: `extensions/ssh-remote/src/host-trust/controller.ts`
- Modify: `extensions/ssh-remote/src/host-trust/index.ts`
- Test: `tests/ssh-remote-host-trust.test.ts`

**Interfaces:**
- Produces: `SshHostTrustController.connectWithTrust<T>(ctx, attempt): Promise<T>`
- Constructor accepts persistent path and max confirmations (default 17).

- [ ] Write failing tests for Chinese confirmation content, accept/write/retry, reject/no-write, headless failure, duplicate candidate loop, max 17, concurrent same-candidate prompt deduplication and changed-key no-prompt.
- [ ] Run test and verify RED.
- [ ] Implement one in-flight decision Promise per `lookupHost + fingerprint`; accepted candidate writes via store then retries; all failure paths are bounded and fail closed.
- [ ] Run test and verify GREEN.
- [ ] Commit `feat(ssh): confirm first-use host fingerprints`.

### Task 4: saved-server pool 与 OpenSSH 严格参数

**Files:**
- Modify: `extensions/ssh-remote/src/transport/client.ts`
- Modify: `extensions/ssh-remote/src/servers/connection-pool.ts`
- Modify: `extensions/ssh-remote/src/extension.ts`
- Test: `tests/ssh-remote-host-trust.test.ts`
- Test: `tests/ssh-remote-servers.test.ts`
- Test: `tests/ssh-remote.test.ts`

**Interfaces:**
- `SshClientOptions.knownHostsFile?: string`
- `ServerConnectionPoolOptions.hostTrust: SshHostTrustController`
- OpenSSH args include persistent user file, system global file and `StrictHostKeyChecking=yes`.

- [ ] Write failing OpenSSH argument tests for Unix/Windows and pool tests proving unknown key is confirmed once then retried.
- [ ] Run focused tests and verify RED.
- [ ] Add strict arguments to every OpenSSH invocation, including master/control/background paths through shared option builder.
- [ ] Wrap pool connection attempt in `hostTrust.connectWithTrust()`; pass persistent path to transport factory.
- [ ] Implement OpenSSH preflight with a temporary ssh2 client using identical target/config/port/auth options; preflight incompatibility instructs manual known_hosts provisioning and never weakens strict mode.
- [ ] Run server, OpenSSH, ssh2, password and ProxyJump tests; expect GREEN.
- [ ] Commit `feat(ssh): enforce persistent host trust for saved servers`.

### Task 5: 完整远程工作区接线

**Files:**
- Modify: `extensions/ssh-remote/src/extension.ts`
- Modify: `extensions/ssh-remote/src/resources/controller.ts` only if user-visible text changes
- Test: `tests/ssh-remote-host-trust.test.ts`
- Test: `tests/ssh-remote.test.ts`
- Test: `tests/ssh-remote-windows-integration.test.ts`

**Interfaces:**
- Consumes shared `SshHostTrustController` from Task 3.
- All `/ssh-connect`, resume, reconnect and AI `ssh_connect` attempts run through trust confirmation loop.

- [ ] Write failing extension harness tests for first-use confirmation, cancellation, headless resume, changed key, persisted restart simulation and sequential ProxyJump candidates.
- [ ] Run focused tests and verify RED.
- [ ] Instantiate one controller per extension runtime and wrap full connection client selection; add Chinese waiting/saved/error notifications while keeping raw diagnostics.
- [ ] Ensure AI password timeout and host-key confirmation are independent; host-key prompt must not be treated as a password prompt.
- [ ] Run mode, lifecycle, Windows and complete SSH regression tests; expect GREEN.
- [ ] Commit `feat(ssh): apply TOFU to SSH workspaces`.

### Task 6: 文档与完整发布验证

**Files:**
- Modify: `extensions/ssh-remote/README.md`
- Modify: `tests/README.md`
- Modify: `docs/superpowers/specs/2026-09-09-persistent-known-hosts-tofu-design.md` only for implementation clarifications

- [ ] Document persistent path, TOFU workflow, changed-key remediation, ProxyJump behavior, manual provisioning limitation and Secret/PVC layout.
- [ ] Run `git diff --check` and source scan proving no insecure host-key flags.
- [ ] In Node 24 + Bun 1.3.14 Docker run `bun install --frozen-lockfile`, `bun run check`, and `bun run pack:ssh-remote`.
- [ ] Verify no real host, key or fingerprint fixtures; run privacy check.
- [ ] Commit `docs(ssh): document persistent host trust`.
- [ ] Review complete diff for trust-boundary bypasses, retry loops, path escape, secret logging and transport inconsistency; fix findings and rerun full verification.
