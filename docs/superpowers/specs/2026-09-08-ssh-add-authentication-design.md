# `/ssh add` 认证配置设计

日期：2026-09-08

## 目标

调整 SSH Remote 插件的 `/ssh add` 流程：

1. OpenSSH 配置路径输入框默认显示 Pi 持久配置目录中的 `ssh/config`。
2. 新增认证方式选择：密码认证或密钥认证。
3. 密码复用现有安全存储和传输机制。
4. 私钥由插件托管，服务器配置只保存私钥路径。
5. `/ssh test`、`ssh_exec`、`ssh_sync` 和完整远程工作区始终复用服务器选定的认证策略。
6. SSH Remote 插件的全部用户可见界面文字统一为中文，同时保持技术标识和持久化值兼容。

## 非目标

本次不实现：

- GitLab/GitHub Token 或 OAuth 管理。
- 向 GitLab/GitHub API 注册公钥。
- 自动生成 SSH 密钥。
- 加密私钥 passphrase 的输入、保存或解锁。
- 任意目录私钥写入。
- 自动修改用户 OpenSSH `Host` 配置块。
- Git remote、commit 或 push 管理。
- 通用国际化框架、语言切换或翻译资源系统；当前只提供中文界面。
- 翻译命令名、工具名、参数名、Shell 名称、传输实现名或 OpenSSH 指令。

## 配置模型

`SavedSshServer` 新增：

```ts
type SshAuthenticationPreference = "auto" | "password" | "key";

interface SavedSshServer {
  // 现有字段
  authenticationPreference: SshAuthenticationPreference;
  identityFile?: string;
}
```

语义：

- `auto`：保留当前认证行为，用于兼容旧配置。
- `password`：OpenSSH 中密码和 keyboard-interactive 优先、公钥后备；ssh2 中密码优先、公钥和 agent 后备。
- `key`：指定的 `identityFile` 优先，密码作为后备。

服务器存储文档版本保持为 1。读取旧服务器记录时，缺少 `authenticationPreference` 应规范化为 `auto`；缺少 `identityFile` 保持未设置。这样无需迁移现有配置。

约束：

- `authenticationPreference === "key"` 时必须有绝对 `identityFile`。
- 非 `key` 模式不保存 `identityFile`，避免陈旧配置产生歧义。
- 密码永远不进入 `ssh-remote-servers.json`。

## `/ssh add` 交互流程

流程调整为：

```text
1. 服务器名称
2. 描述（可选）
3. SSH 目标或 OpenSSH 别名
4. 显式端口（可选）
5. 本地 OpenSSH 配置文件
6. 认证方式
7A. SSH 密码
或
7B. 托管密钥文件名
8B. 粘贴私钥（多行编辑器）
9. 远端 Shell
10. SSH 传输方式
11. 测试连接
12. 保存服务器
```

任何输入弹框被取消时，流程立即停止，不保存服务器、密码或新私钥。

界面显示文字全部使用中文，例如：

```text
服务器名称
描述（可选）
SSH 目标或 OpenSSH 别名
显式端口（可选）
本地 OpenSSH 配置文件
认证方式
密码
私钥
远端 Shell
SSH 传输方式
```

技术选项值保持原样，例如 `auto`、`bash`、`pwsh`、`openssh` 和 `ssh2`；需要解释时使用中文标签，例如 `auto（自动）`，但写入配置的值仍为 `auto`。

### OpenSSH 配置路径

输入框默认值通过以下方式计算：

```ts
join(getAgentDir(), "ssh", "config")
```

当前运行环境中显示为：

```text
/home/node/.pi/agent/ssh/config
```

不得硬编码 `/home/node`。用户仍可输入 `~`、绝对路径或相对路径；相对路径沿用当前规则，相对于命令上下文的 `cwd` 展开。

### 认证方式

选择项：

```text
密码认证
密钥认证
```

`/ssh add` 不提供 `Auto`，因为新增服务器应明确选择认证方式。旧服务器继续支持 `auto`。

## 密码认证

选择“密码认证”后弹出中文密码输入框。密码通过现有 `SshPasswordResolver` 注入，不新增 secret store。

存储行为遵循现有 `Persist passwords` 设置：

- 开启：写入 `<getAgentDir()>/ssh-remote-secrets.json`，权限 `0600`。
- 关闭：仅保存在当前 Pi 进程内存中。

密码使用解析后的最终 endpoint 键保存，格式与现有机制一致：

```text
user@host:port
```

如果目标是 OpenSSH alias，应先解析有效的 host、user 和 port，再绑定密码，避免使用 alias 键导致 OpenSSH 与 ssh2 无法共享密码。

连接测试失败时：

- 被服务端拒绝的密码从内存和持久存储移除。
- 网络错误、主机密钥错误或远端探测错误不得误删密码。

认证优先级：

```text
password, keyboard-interactive, publickey
```

这表示优先使用用户选择的密码，但允许必要后备认证。

## 密钥认证

### 文件位置

私钥统一托管到：

```text
<getAgentDir()>/ssh/<用户填写的文件名>
```

例如：

```text
/home/node/.pi/agent/ssh/id_ed25519_test
```

用户只能填写文件名，不能填写路径。允许字符：

```text
A-Z a-z 0-9 . _ -
```

必须拒绝：

- 空名称；
- `.` 和 `..`；
- `/`、`\`；
- NUL、换行和其他控制字符；
- 解析后不位于 `<getAgentDir()>/ssh/` 直属范围内的名称。

### 私钥输入

使用 Pi 原生多行编辑器：

```ts
ctx.ui.editor("粘贴私钥", "")
```

输入内容必须：

- 是受支持的 OpenSSH 或 PEM 私钥格式；
- 不是 `.pub` 公钥；
- 不是证书；
- 不是加密私钥；
- 非空且大小受限。

本次采用最小边界：私钥文本最大 1 MiB。超过上限直接拒绝。

错误消息只能说明类型或验证失败，不得包含私钥内容。

### 私钥验证

使用项目已安装的 `ssh2.utils.parseKey()` 解析 OpenSSH 和 PEM 私钥；只接受 `isPrivateKey()` 为真的未加密私钥。解析错误若包含 encrypted/passphrase 则按加密私钥拒绝，其他错误统一按无效私钥拒绝。不得新增依赖或调用外部密钥工具。

检测到加密私钥时拒绝，并提示：

```text
Encrypted private keys are not supported here. Use SSH Agent or an unencrypted dedicated deployment key.
```

不新增私钥解析依赖。

### 写入与覆盖

写入步骤：

1. 创建 `<getAgentDir()>/ssh/`，目录权限限制为 `0700`。
2. 在同目录创建随机临时文件。
3. 以 `0600` 写入私钥。
4. 再次确认临时文件不是符号链接且位于托管目录。
5. 原子 rename 到目标文件。
6. 强制最终权限为 `0600`。

目标已存在时：

- 必须是普通文件，不得是符号链接、目录或设备。
- 弹窗确认后才允许覆盖。
- 如果其他服务器记录引用该文件，确认信息必须列出引用服务器名称并警告覆盖会影响它们。
- 覆盖前将原内容和 mode 保存在进程内，直到连接测试与服务器保存完成。

失败回滚：

- 新文件：测试或保存失败时删除。
- 覆盖文件：测试或保存失败时原子恢复旧内容和原 mode。
- 流程成功后丢弃内存中的回滚副本。
- 私钥内容不得写入日志、通知、测试快照或错误对象。

认证优先级：

```text
指定 identityFile, 其他 publickey/agent, password, keyboard-interactive
```

所选托管密钥必须优先，但允许必要后备认证。

## 传输层行为

### OpenSSH

`SshClientOptions` 增加认证偏好和可选 `identityFile`。命令参数按模式追加：

密码模式：

```text
-o PreferredAuthentications=password,keyboard-interactive,publickey
```

密钥模式：

```text
-i <identityFile>
-o IdentitiesOnly=no
-o PreferredAuthentications=publickey,password,keyboard-interactive
```

使用 `IdentitiesOnly=no` 是为了满足“指定密钥优先但允许其他密钥/Agent 后备”。显式 `-i` 的 identity 会优先进入候选集合。

密码通过现有 sshpass/ssh2 回退机制传递，不出现在命令参数、日志或进程参数中。

### ssh2

OpenSSH config 解析仍用于获取最终 host、user、port、ProxyJump 和 known_hosts。

认证方法顺序根据服务器配置调整：

- `password`：password、指定/配置密钥、agent。
- `key`：显式 `identityFile`、配置密钥、agent、password。
- `auto`：保持当前顺序。

显式 `identityFile` 需通过现有私钥读取和权限检查路径加载，不复制到连接配置 JSON。

### 连接池

`ServerConnectionPool` 创建 client 时传入：

```ts
authenticationPreference
identityFile
```

连接池 key 已包含服务器 `updatedAt`，认证配置修改后会自然创建新 generation，旧连接在租约释放后关闭。

## `/ssh edit`

为保持服务器生命周期一致，`/ssh edit` 同样支持修改认证方式：

- 切换到密码：弹出密码输入；成功保存后服务器记录移除 `identityFile`，但不自动删除旧托管私钥。
- 切换到密钥：执行与 add 相同的文件名、私钥、覆盖确认和回滚流程。
- 保持当前密钥：编辑器不预填私钥，也不读取私钥内容到 UI；提供 `Keep current key` 选项。

私钥永远不能从磁盘读出后展示给用户。

## 删除服务器

删除服务器时：

- 密码沿用现有显式 forget 功能，不自动删除，避免误删同 endpoint 被其他服务器使用的密码。
- 若服务器引用托管目录内的私钥，且没有其他服务器引用，询问是否删除。
- 有其他服务器引用时不允许删除密钥文件。
- 托管目录之外的文件永不由删除流程删除。

## 中文界面范围

整个 SSH Remote 插件的用户可见界面统一为中文，不限于 `/ssh add`。覆盖：

- `ctx.ui.input()`、`ctx.ui.select()`、`ctx.ui.confirm()`、`ctx.ui.editor()` 的标题、占位提示和选项标签；
- `ctx.ui.notify()` 的成功、警告和错误说明；
- `/ssh` 服务器管理和项目映射菜单；
- `/ssh-connect`、`/ssh-exit`、重连、cwd 切换和密码重试界面；
- 私钥覆盖、回滚和删除确认；
- `/aoliyougei-settings` 中 SSH Remote 的标题、设置名称、说明和显示选项；
- 状态栏、Footer 和插件生成的用户可读状态；
- `ssh_list_servers`、`ssh_exec`、`ssh_sync` 返回结果中的用户可读文字；
- 插件主动产生的错误消息。

保持英文且不得重命名的技术标识：

```text
/ssh
/ssh add
/ssh-connect
ssh_exec
ssh_sync
ssh_list_servers
auto
bash
zsh
sh
pwsh
powershell
openssh
ssh2
Host
IdentityFile
ProxyJump
known_hosts
```

同样保持兼容的内容：

- 命令注册 ID、工具 ID、JSON 字段名、事件名和状态 key；
- 配置文件中的枚举值；
- 远端路径、主机名、用户名和用户输入；
- OpenSSH/ssh2/操作系统返回的原始诊断文本。原始诊断可附在中文上下文之后，不篡改内容，便于检索排障。

本次直接使用中文字符串，不引入 i18n 依赖、locale 自动检测或翻译字典。重复且容易漂移的选项标签可使用同文件内的最小常量映射，但不建立通用翻译框架。

## 存储与权限

涉及文件：

```text
<getAgentDir()>/ssh/config
<getAgentDir()>/ssh/<managed-key>
<getAgentDir()>/ssh-remote-servers.json
<getAgentDir()>/ssh-remote-secrets.json
```

权限要求：

- `ssh/`：`0700`
- 私钥：`0600`
- servers JSON：`0600`
- secrets JSON：`0600`

服务器 JSON 示例：

```json
{
  "version": 1,
  "id": "...",
  "name": "test-server",
  "target": "deploy@test-server",
  "configFile": "/home/node/.pi/agent/ssh/config",
  "authenticationPreference": "key",
  "identityFile": "/home/node/.pi/agent/ssh/id_ed25519_test",
  "shellPreference": "auto",
  "transportPreference": "auto",
  "createdAt": "...",
  "updatedAt": "..."
}
```

不允许出现：

```text
password
privateKey
keyContents
passphrase
```

## 错误处理

以下任一情况均不得保存服务器：

- 用户取消；
- config 路径无效；
- 密码为空；
- 私钥文件名非法；
- 私钥为空、过大、无效或加密；
- 用户拒绝覆盖；
- 私钥安全写入失败；
- SSH 连接或远端探测失败；
- 服务器名称冲突；
- 服务器 store 保存失败。

密钥模式必须回滚文件变更。密码模式仅在认证明确失败时移除已拒绝密码。

## 测试策略

采用 TDD，至少覆盖：

1. `/ssh add` config 输入默认显示 `join(getAgentDir(), "ssh", "config")`。
2. 旧服务器记录规范化为 `authenticationPreference: "auto"`。
3. 密码和私钥内容不会进入服务器 JSON。
4. 密码遵循 `Persist passwords`。
5. 密码认证参数顺序正确。
6. 密钥文件名路径穿越被拒绝。
7. 私钥以 `0600` 原子写入。
8. 公钥、无效私钥、加密私钥和超大私钥被拒绝。
9. 已有私钥未经确认不会覆盖。
10. 测试失败删除新文件或恢复旧文件。
11. 被其他服务器引用时显示覆盖警告。
12. OpenSSH 显式 identity 和认证顺序正确。
13. ssh2 显式 identity 和认证顺序正确。
14. `/ssh edit` 不把现有私钥读回 UI。
15. 删除最后一个引用时询问，存在共享引用时不删除。
16. 新旧服务器配置均能正常连接。
17. `/ssh`、连接、映射、密码、密钥和设置界面的用户提示均为中文。
18. 技术标识、配置枚举、命令 ID 和工具 ID 保持原值。
19. 原始 SSH/操作系统错误前附中文上下文，但原始诊断文本保持不变。

测试不得使用真实用户名、主机、私钥或凭据。使用临时目录和测试生成的短期未加密密钥。

## 文档

更新 `extensions/ssh-remote/README.md`：

- 新 `/ssh add` 流程；
- 默认 config 路径；
- 密码持久化语义；
- 托管私钥目录和权限；
- 不支持加密私钥；
- 删除服务器与共享密钥行为；
- GitLab/GitHub endpoint 与普通远程 Shell 主机的区别；
- 全部命令示例保留英文技术标识，说明文字使用中文。
