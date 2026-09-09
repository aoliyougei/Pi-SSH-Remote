# SSH 持久 known_hosts 与首次指纹确认设计

日期：2026-09-09

## 目标

为 SSH Remote 插件增加 TOFU（Trust On First Use）主机密钥确认：

1. 所有插件发起的 SSH 连接显式使用 Pi 配置目录中的持久 `known_hosts`。
2. 已知且匹配的主机自动通过严格校验。
3. 未知主机先在 Pi 中文弹框中显示算法与 SHA-256 指纹，用户确认后才持久化并重试连接。
4. 已知主机指纹变化时立即拒绝，绝不自动覆盖。
5. OpenSSH、ssh2、保存服务器、`ssh_exec`、`ssh_sync`、`/ssh test` 和完整远程工作区共享同一信任库。
6. ProxyJump 链中的每个未知节点逐个确认。

## 非目标

本次不实现：

- `StrictHostKeyChecking=no` 或无提示自动信任。
- 自动接受或替换变化后的主机密钥。
- CA 签发、DNS SSHFP、GitHub/GitLab API 指纹查询或外部资产系统集成。
- 同步 Kubernetes Secret、创建 PVC 或修改 Pod/Deployment。
- 通用凭据管理器。
- 自动信任系统级 `/etc/ssh/ssh_known_hosts` 之外的新文件。

## 持久路径与权限

路径通过运行时计算，禁止硬编码用户目录：

```ts
join(getAgentDir(), "ssh", "known_hosts")
```

当前标准容器中对应：

```text
/home/node/.pi/agent/ssh/known_hosts
```

权限：

- `<getAgentDir()>/ssh/`：`0700`
- `known_hosts`：`0600`

如果目标目录或文件是符号链接、目录、设备或其他特殊文件，拒绝写入。目录必须位于可写持久卷；Secret volume 的只读挂载会产生明确中文错误，不回退到临时信任或关闭校验。

## 信任模型

### 已知且匹配

使用 OpenSSH known_hosts 语义查找目标：

- 默认 22 端口：`host`
- 非 22 端口：`[host]:port`
- 配置了 `HostKeyAlias`：使用 alias

匹配任一非 revoked 主机密钥时允许连接。

### 未知主机

握手阶段获取服务端主机公钥，在任何用户认证之前停止当前尝试。计算：

```text
密钥类型：ssh-ed25519 / rsa-sha2-* / ecdsa-sha2-* 等
指纹：SHA256:<无填充 Base64 SHA-256>
```

中文确认弹框显示：

```text
确认 SSH 主机指纹

目标：host:port
密钥类型：ssh-ed25519
SHA-256 指纹：SHA256:...

这是首次连接该主机。请通过可信渠道核对指纹。
是否信任并保存？
```

用户确认后，以标准 OpenSSH 行格式写入持久文件：

```text
host-token key-type base64-key
```

然后从连接流程起点重试。用户拒绝或关闭弹框时，不写入、不认证、不连接。

### 已知但冲突

如果目标在 known_hosts 中已有记录，但服务端提供的 key 不匹配：

- 拒绝连接；
- 显示中文高危错误；
- 显示当前观察到的算法和 SHA-256 指纹；
- 不自动删除、追加或替换任何记录；
- 指导用户在核实后手工使用 `ssh-keygen -R` 或编辑持久文件。

`@revoked` 命中始终拒绝，不能通过弹框覆盖。

## 统一主机密钥候选

新增内部错误类型：

```ts
class UnknownSshHostKeyError extends Error {
  readonly candidate: SshHostKeyCandidate;
}

interface SshHostKeyCandidate {
  lookupHost: string;
  host: string;
  port: number;
  keyType: string;
  keyBase64: string;
  fingerprint: string;
  role: "target" | "jump";
}
```

错误消息不得包含私钥、密码或认证信息。主机公钥不是秘密，但只在确认界面和必要诊断中显示指纹，不默认输出完整 Base64 key。

## ssh2 探测与连接

现有 ssh2 `hostVerifier` 已读取 OpenSSH known_hosts。扩展其结果：

1. 已知匹配：返回 `true`。
2. revoked/冲突：设置明确拒绝原因并返回 `false`。
3. 无记录：解析 SSH host-key blob 的算法，生成 `SshHostKeyCandidate`，返回 `false`。
4. `Ssh2Client` 将未知候选转换为 `UnknownSshHostKeyError`，交由上层确认。

`hostVerifier` 是同步回调，禁止在回调中打开 UI 或写文件。UI 确认必须在连接尝试退出后由上层异步执行。

ProxyJump 按连接链顺序工作：

```text
未知 jump-1 → 捕获并确认 → 重试
未知 jump-2 → 捕获并确认 → 重试
未知 target → 捕获并确认 → 重试
全部已知 → 进入用户认证
```

已经确认的 jump 节点可以在后续尝试中认证，以便到达下一跳；未确认节点永远不会进入用户认证。

为避免无限循环，同一连接操作最多确认 17 个节点（16 个 jump + 目标），同一 `lookupHost + key` 在一次操作中不得重复弹框。

## OpenSSH 连接

所有 OpenSSH 命令显式追加：

```text
-o UserKnownHostsFile=<persistent-known-hosts>
-o GlobalKnownHostsFile=/etc/ssh/ssh_known_hosts
-o StrictHostKeyChecking=yes
```

不依赖容器易失的 `~/.ssh/known_hosts`，也不使用 `accept-new`。

OpenSSH 本身以 BatchMode 运行，不能安全地将终端 host-key prompt 转换为 Pi 异步 UI。因此在创建或使用 OpenSSH transport 前，执行一次共用的 ssh2 主机密钥预检：

- 预检只负责到达各节点并验证/捕获 host key；
- 未知 key 由上层弹框确认并持久化；
- 全部节点受信任后才启动正式 OpenSSH transport；
- 预检复用同一 OpenSSH config、目标、端口、ProxyJump 和密码 provider；
- 不支持 ssh2 解析的高级 OpenSSH 配置（如任意 `ProxyCommand`）不能自动 TOFU，返回中文错误并指导用户手工预置 persistent known_hosts；绝不降低校验等级。

这是一项刻意限制：比实现跨平台 SSH_ASKPASS IPC 更小、更可审计。若未来真实需求要求任意 OpenSSH 配置的自动确认，再增加专用 askpass broker。

## 上层确认循环

新增小型 `SshHostTrustController`，由完整远程连接和 saved-server connection pool 共用：

```ts
await hostTrust.connectWithTrust(ctx, createAttempt)
```

行为：

1. 调用 `createAttempt()`。
2. 普通成功直接返回。
3. 捕获 `UnknownSshHostKeyError`。
4. 无 UI 时拒绝，提示需交互确认或预置 known_hosts。
5. 有 UI 时显示中文确认。
6. 拒绝则抛出取消错误。
7. 确认则事务式写入并从步骤 1 重试。
8. 冲突、revoked、I/O、解析和其他错误直接失败，不弹“信任”确认。

并发连接遇到同一未知 key 时，以进程内 `lookupHost + fingerprint` Promise 去重，只显示一个弹框；其他连接等待相同决定。不同主机仍可独立确认。

## known_hosts 写入

新增专用 store 模块，职责仅限解析目标记录、检查冲突和事务写入。

写入流程：

1. 确保目录存在且为真实目录；设置 `0700`。
2. 若文件不存在，以空内容开始。
3. 若文件存在，要求是普通文件且不是符号链接，最大读取 16 MiB。
4. 重新检查候选是否已经存在；存在则幂等成功。
5. 如果同一 lookupHost 有冲突记录，拒绝写入。
6. 保留注释、空行、hashed hosts、通配符和不相关记录原样。
7. 在同目录创建随机临时文件，权限 `0600`。
8. 追加规范化记录和单个末尾 LF。
9. `fsync` 临时文件后原子 rename。
10. 强制最终权限 `0600`，失败时清理临时文件。

不调用 `ssh-keyscan`，因为它获得的 key 同样来自未认证网络且无法自然覆盖 ProxyJump；直接使用实际 SSH 握手观察到的 key 更一致。

## 配置文件行为

插件保存服务器时继续允许用户选择 OpenSSH config。无论 config 中是否设置其他 `UserKnownHostsFile`，插件管理的连接必须显式加入 persistent known_hosts，确保容器重启后行为一致。

系统级：

```text
/etc/ssh/ssh_known_hosts
```

仍作为只读附加信任源。为确保 ssh2 预检与正式 OpenSSH 行为一致，不自动读取 OpenSSH config 中其他 `UserKnownHostsFile` 或 `GlobalKnownHostsFile`；需要保留的用户记录应迁移到 Pi 持久文件，系统管理员记录应放入系统级文件。新的 TOFU 记录只写 Pi 持久文件。

## UI 文案

所有新增界面使用中文，以下技术标识保持英文：

```text
SSH
SHA-256
known_hosts
HostKeyAlias
ProxyJump
ssh-keygen -R
```

状态/通知示例：

```text
正在验证 SSH 主机指纹…
已保存 SSH 主机指纹：host:port
SSH 主机指纹不匹配：host:port
known_hosts 不可写：<原始系统错误>
```

原始 OpenSSH/ssh2/OS 错误附在中文上下文后，不改写原文。

## 容器与 Kubernetes 部署要求

插件只能持久化到可写存储。推荐：

```text
Secret（只读）：<PI_CODING_AGENT_DIR>/ssh/id_ed25519
PVC（可写）：<PI_CODING_AGENT_DIR>/ssh/known_hosts
```

若 Kubernetes 无法同时以预期方式挂载同一目录，可将整个 `ssh/` 放在 PVC，并以 Secret `subPath` 挂载私钥文件。私钥 `0400` 或 `0600` 均可；known_hosts 必须可由 Pi 进程写入。

若只提供 `emptyDir`，TOFU 仍能在单次 Pod 生命周期工作，但重建 Pod 后会重新确认，不满足持久化目标。

## 错误与失败关闭

以下情况必须失败关闭：

- 无 UI 且主机未知；
- 用户拒绝或取消；
- fingerprint 冲突或 revoked；
- persistent known_hosts 不可读/不可写；
- 目录或文件是符号链接/特殊文件；
- host-key blob 无法解析；
- 超过确认节点上限；
- ssh2 预检无法兼容有效 OpenSSH 配置；
- 连接重试后重复报告同一未知 key。

任何错误都不能回退到 `StrictHostKeyChecking=no`、`accept-new`、容器临时 known_hosts 或静默接受。

## 测试策略

采用 TDD，覆盖：

1. 默认 persistent known_hosts 路径使用 `getAgentDir()`。
2. OpenSSH 参数始终指定 persistent 文件和 `StrictHostKeyChecking=yes`。
3. 默认端口与非默认端口 lookupHost 格式。
4. key blob 算法解析与 SHA-256 指纹。
5. 已知匹配自动通过。
6. 未知 key 只产生候选，不进入认证。
7. 用户确认后原子写入并重试成功。
8. 用户拒绝后文件不变。
9. 无 UI 时未知 key 失败。
10. 已知冲突和 revoked 不显示信任弹框、不修改文件。
11. 同一候选并发确认去重。
12. 目录/文件符号链接拒绝。
13. 文件和目录权限分别为 `0600`、`0700`。
14. 只读目录返回明确错误且不降低安全设置。
15. 写入保留注释、hashed hosts 和其他记录。
16. ProxyJump 节点按顺序逐个确认。
17. 超过 17 个候选或重复候选失败。
18. OpenSSH 正式连接只在预检完成后启动。
19. ssh2 与 OpenSSH 使用同一持久文件。
20. Windows 路径与 `ssh.exe` 参数正确。
21. 中文弹框和通知，技术标识保持不变。
22. 现有 password/key authentication、镜像和模式隔离回归继续通过。

测试只使用运行时生成的公钥 blob、临时目录和固定虚构主机；不得提交真实 host key、私钥、用户名、地址或指纹。

## 文档

更新 `extensions/ssh-remote/README.md`，说明：

- TOFU 首次确认流程；
- persistent known_hosts 路径和权限；
- 指纹变化失败关闭；
- ProxyJump 逐节点确认；
- 高级 OpenSSH 配置的手工预置信任限制；
- Kubernetes Secret 与 PVC 的推荐挂载方式；
- `0400` 私钥权限合法，known_hosts 需要可写存储。
