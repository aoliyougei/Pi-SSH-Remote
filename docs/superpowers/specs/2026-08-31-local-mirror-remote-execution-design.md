# SSH Remote：本地代码镜像与独立远程执行设计

## 1. 背景与目标

现有 `@aoliyougei/pi-ssh-remote` 将 Pi 的文件、搜索和 Shell 工具整体路由到通过 `/ssh-connect` 激活的远程工作区。本设计在不改变该模式的前提下，增加第二种工作流：Pi-Web 在本地目录开发代码，插件持续把代码严格镜像到测试服务器，Agent 再通过独立的 `ssh_exec` 工具在测试服务器构建、测试、运行和排障。

核心原则：

- **本地开发模式**：代码读取、搜索、生成和修改全部发生在本地；本地变化自动镜像到测试服务器；实际构建、测试、启动和排障通过 `ssh_exec` 在远端执行。
- **完整远程工作区模式**：通过 `/ssh-connect` 或 `--ssh` 进入后，继续保持现有行为，文件与命令工具全部操作远端。
- 本地目录是镜像代码的唯一可信源；远端代码必须与本地同步范围严格一致。
- 自动同步不自动运行测试；Agent 根据任务主动调用 `ssh_exec`，用户无需额外提醒同步或远程验证。
- 同步与远程执行不得改变 Pi 当前工作区模式。

参考项目 `https://github.com/yu-d1/pi-extensions` 中 `packages/ssh-manager` 的服务器管理、`ssh_exec` 和 `ssh_list_servers` 交互语义，但不复制其独立认证、明文密码配置或简单命令前缀安全判断。

## 2. 范围与非目标

### 2.1 本期范围

- SSH 服务器元数据管理。
- 本地项目到服务器远程目录的映射。
- 首次目录授权和远程 marker。
- Git 优先、文件系统回退的本地同步清单。
- 本地代码变化的自动严格镜像。
- 远端保护路径、严格删除、安全符号链接和完整校验。
- `ssh_sync`、`ssh_exec`、`ssh_list_servers` 工具。
- `/ssh` 管理菜单及子命令、`/ssh-sync`。
- 与现有 `/ssh-connect` 生命周期和状态的严格隔离。
- Unix、Windows、OpenSSH、ssh2、ProxyJump 和现有密码体系兼容。

### 2.2 非目标

- 不要求远端安装 rsync、tar、Git、Node.js、Python 或同步 Agent。
- 不使用 SFTP 作为必要前提。
- 不在首版导入参考插件的明文密码配置。
- 不自动运行、重启或部署服务；这些由 Agent 显式调用 `ssh_exec`。
- 不硬拦截本地 `bash` 中的构建或测试命令，仅通过动态上下文和工具指导引导 Agent。
- 不保证整个目录切换原子性；采用原地同步，但单文件尽量通过同目录临时文件原子替换。
- 不镜像 `.git` 对象、文件所有者、ACL、扩展属性或 Windows Alternate Data Streams。

## 3. 总体架构

插件仍作为一个 npm 包发布，在同一插件内建立独立子系统：

```text
extensions/ssh-remote/src/
├── extension.ts                 # 注册入口、工作区状态和生命周期协调
├── servers/
│   ├── types.ts
│   ├── store.ts
│   ├── controller.ts
│   └── commands.ts
├── mappings/
│   ├── types.ts
│   ├── store.ts
│   └── controller.ts
├── sync/
│   ├── types.ts
│   ├── manifest.ts
│   ├── git-manifest.ts
│   ├── filesystem-manifest.ts
│   ├── exclusions.ts
│   ├── marker.ts
│   ├── remote-tree.ts
│   ├── synchronizer.ts
│   ├── verifier.ts
│   ├── queue.ts
│   └── watcher.ts
├── exec/
│   ├── controller.ts
│   └── tools.ts
├── transport/                   # 复用现有实现
├── adapters/                    # 复用并扩展远程文件元数据操作
├── background/
├── workspace/
└── resources/
```

`extension.ts` 只负责组装、注册和跨子系统生命周期，不把新功能继续堆叠到现有大文件中。

## 4. 权威状态与模式隔离

### 4.1 当前工作区状态

```ts
type WorkspaceMode =
  | "local"
  | "remote-connecting"
  | "remote-active"
  | "remote-disconnected";
```

该状态是决定 Pi 文件工具路由的唯一权威来源：

- `local`：Pi 文件、搜索、补全和本地 Shell 保持本地。
- `remote-active`：保持现有完整远程工具覆盖。
- `remote-connecting`、`remote-disconnected`：现有远程工具失败关闭，不回退本地。
- `ssh_exec` 和镜像同步均不得改变此状态。

### 4.2 本地镜像状态

```ts
type MirrorState =
  | "unconfigured"
  | "initializing"
  | "watching"
  | "dirty"
  | "syncing"
  | "synced"
  | "failed"
  | "paused";
```

仅当 `WorkspaceMode === "local"` 且当前项目存在映射时运行。同步失败不会影响本地文件工具，也不会显示完整远程工作区的 `SSH: Disconnected`。

### 4.3 独立远程执行状态

```ts
type ExecState = "idle" | "connecting" | "executing";
```

`ssh_exec` 是针对保存服务器的一次独立操作。它不改变工作区路由、会话中的 `/ssh-connect` 状态或镜像状态；只有在命令需要最新代码时等待镜像屏障。

### 4.4 必须保证的隔离

- `ssh_exec` 成功或失败后，本地 `read/write/edit/bash` 仍为本地。
- 自动同步成功不显示 `SSH: Connected`。
- 自动同步失败不触发完整远程工作区断线状态。
- `/ssh-connect` 成功后暂停本地 watcher 和自动镜像。
- `/ssh-exit` 后重新识别本地映射、立即完整同步并恢复 watcher。
- 完整远程工作区断线仍保持现有失败关闭行为。
- `/tree`、resume、reload 不得把镜像状态误当作完整远程状态。

## 5. 服务器配置

### 5.1 模型

```ts
interface SavedSshServer {
  version: 1;
  id: string;
  name: string;
  description?: string;
  target: string;
  port?: number;
  configFile?: string;
  shellPreference: "auto" | "bash" | "zsh" | "pwsh" | "powershell";
  transportPreference: "auto" | "openssh" | "ssh2";
  createdAt: string;
  updatedAt: string;
}
```

服务器配置只保存连接元数据，不保存密码、私钥内容、known_hosts 内容或 Agent 凭据。认证完全复用现有：OpenSSH alias/config、SSH Agent、IdentityFile、ProxyJump、known_hosts、`SshPasswordResolver`、OpenSSH/ssh2 transport。

`name` 大小写不敏感唯一，作为工具稳定引用；映射使用不可变 `serverId`，服务器重命名不破坏映射。

### 5.2 存储

保存至 Pi 用户配置目录，例如：

```text
<Pi Agent 配置目录>/ssh-remote-servers.json
```

要求：

- 有配置版本；
- 结构严格规范化；
- 原子临时文件写入后重命名；
- 未来版本过新时不覆盖原文件，并禁用相关自动能力；
- 不向模型暴露配置文件路径或其他项目的本地路径。

## 6. 项目映射

### 6.1 模型

```ts
interface LocalProjectMapping {
  version: 1;
  id: string;
  projectId: string;
  localRoot: string;
  localRootCanonical: string;
  matchSubdirectories: boolean;
  serverId: string;
  remoteRoot: string;
  autoSync: boolean;
  debounceMs: number;
  localExcludePatterns: string[];
  remoteProtectedPatterns: string[];
  markerId: string;
  paused: boolean;
  createdAt: string;
  updatedAt: string;
}
```

保存至：

```text
<Pi Agent 配置目录>/ssh-remote-mappings.json
```

### 6.2 匹配规则

- 对现有本地目录执行 realpath/canonicalize。
- Windows 下按规范化、不区分大小写的路径比较。
- 默认 `matchSubdirectories: true`，允许从 monorepo 子目录启动 Pi。
- 多个祖先映射同时匹配时，使用最近的映射根。
- 不按目录名、最近使用记录或相似路径猜测。
- 项目移动后不自动猜测新位置；由用户通过管理 UI 迁移映射。

## 7. `/ssh` 管理命令

新增 `/ssh`，与 `/ssh-connect` 语义严格分离。

### 7.1 菜单和子命令

```text
/ssh                         打开管理菜单
/ssh add                     新增服务器
/ssh edit                    编辑服务器
/ssh rm                      删除服务器
/ssh ls                      列出服务器
/ssh test [server]           测试服务器连接
/ssh config                  远程执行与同步设置
/ssh map                     管理当前本地项目映射
/ssh map add                 创建映射
/ssh map show                查看映射
/ssh map edit                编辑映射
/ssh map rm                  删除映射
/ssh map pause               暂停自动镜像
/ssh map resume              立即同步并恢复 watcher
/ssh sync                    手动同步别名
```

现有命令保持：

```text
/ssh-connect
/ssh-exit
/ssh-cd
/ssh-status
/ssh-reconnect
/ssh-forget-password
/ssh-sync
```

### 7.2 服务器管理规则

- 新增服务器时输入名称、说明、target、可选端口/config、Shell 和 transport；执行无副作用连接测试后保存。
- 连接测试只建立临时连接，不切换工作区、不启动同步。
- 编辑连接字段后必须重新测试；正在运行的操作继续使用启动时的不可变旧快照。
- 删除仍被映射引用的服务器时默认拒绝，并可选择同时删除映射。
- 删除服务器或映射不删除远程目录、marker、私钥或 OpenSSH 配置。
- `/ssh ls` 和 `ssh_list_servers` 不显示密码、私钥内容或缓存状态。

### 7.3 项目映射创建

创建流程：

1. 确认本地项目根；
2. 选择服务器；
3. 输入远程镜像根；
4. 配置排除、保护和防抖；
5. 测试连接；
6. 验证远程路径安全；
7. 显示首次同步的上传、覆盖和严格删除摘要；
8. 用户一次性确认授权；
9. 创建并校验 marker；
10. 事务式保存映射；
11. 立即执行首次完整同步；
12. 成功后启动 watcher。

更换服务器、远程根、项目 ID，或移除保护规则扩大删除范围时必须重新授权。新目标失败时保留原映射和 watcher。

## 8. 远程授权 marker 与危险目录

远程根必须包含普通文件：

```text
.pi-ssh-sync.json
```

结构：

```json
{
  "version": 1,
  "markerId": "random-id",
  "mappingId": "random-id",
  "projectId": "random-id",
  "remoteRoot": "/srv/test/project",
  "createdAt": "ISO timestamp"
}
```

不得包含本地真实路径、用户名、密码、私钥路径、OpenSSH config 内容或会话路径。

除首次授权引导创建 marker 外，任何远端写入或删除前都要重新验证：marker 是普通文件、JSON 和版本有效、三个 ID 匹配、规范化 remoteRoot 完全一致、服务器 ID 匹配。首次创建 marker 只能发生在用户已确认同步预览之后，且在创建前必须完成危险根、真实路径、写权限和目标类型检查；创建 marker 之前不得上传、覆盖或删除项目内容。已有 marker 验证失败时必须保证上传、覆盖、删除调用均为零，也不得继续依赖最新代码的远程验证。

### 8.1 硬禁止同步根

Unix 至少禁止目录本身：

```text
/ /bin /boot /dev /etc /home /lib /lib64 /opt /proc /root
/run /sbin /srv /sys /tmp /usr /var 以及远程用户 home 本身
```

允许其安全子目录，如 `/srv/test/project`、`/home/deploy/project`。

Windows 至少禁止目录本身：

```text
驱动器根、C:\Windows、Program Files、Program Files (x86)、
ProgramData、C:\Users、用户 Profile 本身、UNC share 根
```

还拒绝控制字符、无法安全规范化、不可写、文件而非目录、通过链接解析到危险目录的目标。

## 9. 本地同步清单

每轮同步重新生成完整清单，watcher 事件只触发 dirty，不作为同步事实来源。

```ts
type LocalManifestEntry =
  | { type: "file"; relativePath: string; absolutePath: string; size: number; sha256: string; executable: boolean }
  | { type: "directory"; relativePath: string }
  | { type: "symlink"; relativePath: string; target: string };

interface LocalMirrorManifest {
  version: 1;
  mode: "git" | "filesystem";
  projectRoot: string;
  entries: Map<string, LocalManifestEntry>;
}
```

相对路径统一使用 `/`，禁止绝对路径、`..` 越界、NUL、换行和空路径。

### 9.1 Git 模式

优先使用 NUL 分隔的 Git 命令获取：

- 已跟踪文件；
- 未跟踪且未被 ignore 的文件；
- 未提交、已暂存和新增内容。

功能等价于：

```text
git ls-files -z --cached --others --exclude-standard
```

映射根是仓库子目录时只同步该子目录。删除路径不进入新清单，严格镜像阶段删除远端对应项。

### 9.2 文件系统回退

Git 不可用、不是仓库或 Git 状态无法读取时：

- 递归扫描项目根；
- 不跟随目录符号链接；
- 使用成熟 ignore 语义处理 `.gitignore`；
- 应用内置敏感排除和项目规则；
- 状态明确标注 `manifest: filesystem`。

## 10. 排除与远程保护

### 10.1 永久敏感保护

始终拒绝上传：

```text
.git/**
.pi-ssh-sync.json
**/.ssh/**
**/id_rsa
**/id_dsa
**/id_ecdsa
**/id_ed25519
明显的私钥文件或包含私钥头的内容
```

命中私钥特征时报告路径，不显示内容。宽泛扩展名规则可以通过一次明确授权放行普通项目文件，但真实私钥内容不可放行。

默认本地排除：

```text
.git/** node_modules/** coverage/** .cache/** .DS_Store Thumbs.db
.env .env.*
```

重新包含 `.env.example`、`.env.sample`、`.env.template`。`dist/`、`build/` 不永久排除，遵循 Git ignore 和项目规则。

### 10.2 远程保护路径

默认：

```text
.pi-ssh-sync.json
.env
.env.*
!.env.example
!.env.sample
!.env.template
node_modules/**
logs/**
uploads/**
runtime/**
tmp/**
*.pid
```

规则采用有序匹配，后面的重新包含规则优先，因此环境模板仍属于代码镜像；真实环境文件继续保留远端版本。保护语义：不上传、不覆盖、不删除、不参与完整内容一致性校验；保护目录祖先不得被删除。marker 永久保护且不可取消。规则拒绝绝对路径、`..` 和控制字符；Windows 比较不区分大小写。

## 11. 安全符号链接

只允许同时满足以下条件的相对链接：

- target 是非空相对路径；
- 本地解析后仍在项目根内；
- 远端解析后仍在镜像根内；
- 不形成循环；
- 不指向敏感、本地排除或远程保护路径；
- 远端平台具备安全创建链接的权限。

拒绝绝对、越界、循环和不受支持的链接。Windows 无权限时同步失败，不静默展开。远端扫描、校验和删除使用 lstat 语义，不跟随链接；校验链接目标文本。

## 12. 严格镜像算法

### 12.1 一致性定义

成功后必须满足：

- 本地清单中的路径、类型和内容在远端一致；
- 安全链接目标一致；
- Unix Git executable 位一致；
- 除保护路径与 marker 外，远端不存在本地清单之外的条目；
- marker 有效；
- 最新本地 generation 未过期。

不强制镜像 mtime、owner/group、ACL 和扩展属性。

### 12.2 远端树

远端扫描返回 file/directory/symlink/other，不跟随链接、不进入保护目录，使用安全编码承载 Unicode 和空格。特殊文件默认导致同步失败。

不依赖远端 `find`、哈希工具、rsync、tar、Git、Python 或 Node.js：

- Unix 使用现有 POSIX `sh` 和 SSH stdin/stdout 文件能力；
- Windows 使用现有 PowerShell adapter；
- 内容哈希在本地计算。

### 12.3 同步计划与顺序

生成：创建目录、上传文件、创建链接、替换类型冲突、删除文件/链接/目录和保护项清单。

执行顺序：

1. 重新验证 marker 与远程根；
2. 处理阻碍创建的类型冲突；
3. 创建父目录；
4. 上传新增和变化文件；
5. 创建或更新链接；
6. 删除本地不存在的非保护文件和链接；
7. 从深到浅删除多余空目录；
8. 第一次完整校验；
9. 修复漂移；
10. 第二次完整校验。

本地是唯一权威源，远端人工修改会被覆盖；远端多余非保护路径会自动删除。

### 12.4 单文件原子替换

普通文件先写同目录随机临时文件，再设置权限并重命名覆盖目标。失败或取消时尽力清理。下一轮只清理能证明属于当前 marker 的遗留临时文件。

整个目录采用原地同步，已接受同步期间远程旧进程可能读取中间状态的边界；插件发起的新 `ssh_exec` 必须等待同步和校验完成。

### 12.5 完整校验

增量操作后重新扫描远端，对全部非保护文件完整读取并在本地计算 SHA-256，比较路径集合、类型、内容、链接目标和 Unix executable 位。

第一次发现漂移后修复一次并二次完整校验。第二次仍不一致则 `MirrorState = "failed"`，不无限修复，不允许依赖最新代码的远程测试。

## 13. Watcher 与同步队列

### 13.1 生命周期

本地会话启动、resume、reload、映射创建和 `/ssh-exit` 后：

```text
识别映射 → 安装 trigger-only watcher → 立即完整同步 → 完整校验 → watcher 进入正常监控
```

trigger-only watcher 只记录本地 generation，不会把镜像标记为已同步。首次同步失败时它继续捕获变化并触发有界重试，状态仍为 `failed`；只有完整校验成功后才显示正常 `watching/synced`。进入 `/ssh-connect` 前停止防抖，等待同步进入安全终点或取消，停止 watcher，状态 `paused`。`/ssh-exit` 后重新完整同步，不能直接沿用旧 `synced`。

不在 extension factory 中启动 watcher、socket或定时器；`session_shutdown` 幂等清理。

### 13.2 事件与防抖

- 监控项目根，尽早忽略 `.git`、`node_modules`、缓存和项目排除项。
- 事件只调用 `markDirty()`；真正同步重新生成完整清单。
- 默认防抖 1500 ms，可配置 250～30000 ms。
- 连续变化重置计时器。
- 同步中再次变化只增加 generation，并在当前轮后立即追加一轮。
- 跨平台递归 watcher 不可用时退化为目录 watcher 集合或低频清单轮询，并显示 `Watcher: polling`。

### 13.3 串行与屏障

同一项目单队列，自动变化、`/ssh-sync`、`ssh_sync`、首次同步和 `ssh_exec` 屏障共用队列。只有：

```text
syncedGeneration === generation
```

且完整校验通过时才是 `synced`。不同项目运行时状态独立；单 Pi 会话只激活当前本地项目 watcher。

## 14. 工具设计

### 14.1 `ssh_list_servers`

无参数。列出服务器名称、说明、非敏感 target、Shell、transport 和映射项目数；当前项目有映射时显示服务器、远程根和镜像状态。不得返回其他项目本地路径、密码、私钥、secrets 路径或 Agent 数据。

### 14.2 `ssh_sync`

参数：

```ts
{ force?: boolean }
```

只操作当前本地项目映射，跳过防抖并等待最新 generation 严格镜像完成。完整远程工作区中拒绝；无映射时提示 `/ssh map add`；失败必须抛错。

用户命令 `/ssh-sync [--force]` 与其共用控制器和队列，命令先 `await ctx.waitForIdle()`。

### 14.3 `ssh_exec`

参数：

```ts
{
  server?: string;
  command: string;
  cwd?: string;
  timeout?: number;
  require_synced?: boolean;
}
```

服务器解析优先级：显式 server → 当前项目映射 → 插件默认服务器 → 唯一保存服务器，否则报歧义。cwd 优先级：显式 cwd → 当前映射 remoteRoot → 登录 cwd。

当本地项目映射、服务器和 cwd 对应当前镜像时，`require_synced` 默认 `true`。执行前等待防抖和队列；dirty 时立即调度；只有最新 generation 完整校验通过才执行。同步失败时阻止命令。

纯日志、进程、端口、资源和服务状态排障可显式 `require_synced: false`；结果必须警告镜像未同步。不得用该参数绕过同步错误来测试或启动新代码。

执行复用现有 adapter Shell 语义，支持 Unix/Windows、AbortSignal、超时、流式更新和进程树清理。非零远程退出码返回输出和退出码，不当作 SSH 断线。最终输出按 50 KB/2000 行尾部截断。

`ssh_exec` 不切换工作区；独立连接失败不污染完整远程工作区状态。

## 15. 独立连接池

按 `serverId` 管理同步和 `ssh_exec` 的连接池，复用当前 transport、adapter、密码解析、ProxyJump 和 keepalive。

连接池对象与完整远程工作区的会话连接分离，即便目标相同也不共享运行时对象，以隔离生命周期和断线状态。底层认证缓存和 OpenSSH 配置仍共享。

- 捕获服务器配置 generation；配置变化后旧连接停止接受新操作并在空闲时关闭。
- 空闲 10 分钟回收。
- reload/shutdown 关闭。
- 正在同步或执行的连接不回收。
- 同服务器并发认证只允许一个流程；等待者共享结果，取消后统一失败，避免多个密码框。

## 16. Agent 动态指导

### 16.1 本地有映射

动态注入权威说明：

> 当前是本地开发工作区。文件和搜索工具操作本地项目。项目自动镜像到已配置测试服务器；本地变化经过防抖后严格同步并完整校验。需要构建、测试、启动、部署或运行代码时，主动使用 ssh_exec，无需等待用户提醒；ssh_exec 会等待最新镜像同步成功。代码分析和修改继续使用本地工具。除非用户明确要求完整远程开发，否则不要调用 ssh_connect。

上下文包含当前服务器名称、远程根、镜像状态和最近错误，不包含凭据、marker ID、配置路径或其他项目本地路径。

### 16.2 完整远程工作区

动态说明文件与 bash 已直接远程化、本地镜像暂停、不要调用 `ssh_sync`；仅在用户明确操作另一台独立服务器时使用 `ssh_exec`。

### 16.3 行为预期

开发任务：本地分析和修改 → watcher 自动同步 → Agent 主动 `ssh_exec` 远程验证 → 失败后远程排障、本地修复、自动再同步和再验证。

用户要求只修改不测试时，不调用 `ssh_exec`，但自动镜像仍按项目配置运行；若连同步也要暂停，使用 `/ssh map pause`。

## 17. 工具开关与权限

新增 `Remote execution tools` 设置，独立于现有 `AI control tools`：

- `AI control tools` 继续只控制 `ssh_connect/ssh_exit/ssh_cd/ssh_status`。
- 存在服务器配置时可激活 `ssh_exec/ssh_list_servers`。
- 当前本地项目有映射时激活 `ssh_sync`。
- 完整远程工作区中停用 `ssh_sync`。
- 没有服务器时不向模型暴露无用执行工具。

`ssh_exec` 确认策略：`never | destructive | always`，默认 `destructive`。危险命令分析检查完整 Shell 组合，只作为辅助风险检测，不能证明命令安全。需要确认但无 UI 时拒绝。确认显示服务器、target、cwd、命令和镜像校验状态。

不采用默认只读命令白名单，因为构建、安装依赖、Docker、迁移和服务操作属于核心场景。

本地 `bash` 不做硬拦截，依靠动态上下文和工具指导。

## 18. 项目信任与凭据安全

只有 `ctx.isProjectTrusted()` 为真时，才允许自动同步、首次同步、`ssh_sync` 和项目映射驱动的远程执行。项目内配置不得覆盖服务器、remoteRoot、保护规则或权限。

凭据要求：

- 不进入服务器配置、工具参数、模型上下文或工具结果；
- OpenSSH 密码只通过 `SSHPASS` 环境；
- ssh2 密码只通过认证协议；
- 使用现有受限 secrets 文件和设置；
- 日志和错误不得输出密码；
- 后台同步需要密码但没有 UI 时失败，不无限弹窗。

## 19. 故障恢复

- 断网：镜像进入 `failed`，本地工具继续；watcher 保持，后续变化或手动同步可重试；有界退避 2s、5s、15s、30s 后等待明确触发。
- 同步中断：正式文件不保留半写内容；清理可证明属于当前 marker 的临时文件；下一轮完整同步恢复。
- 删除失败：不报告成功、不运行远程验证；下一轮继续以本地为权威修复，不回滚已上传的新版本。
- 远端持续变化：只修复一次并二次校验，仍漂移则失败并阻止依赖最新代码的命令。
- marker 丢失或不匹配：不自动重建，零变更，要求通过 `/ssh map` 重新授权。
- 本地项目移动：不猜测；通过映射迁移流程并确认，可保留 projectId/marker。
- 服务器删除：引用映射停止 watcher并失败，不删除远端内容。

## 20. 状态与审计

使用独立 Footer key：

```text
Mirror: Initializing | Watching | Dirty | Syncing | Synced | Failed | Paused
```

现有 `SSH: Connecting/Connected/Disconnected` 保持完整远程工作区专用。

自动同步成功默认只更新 Footer；失败通知去重；从失败恢复时通知一次。`/ssh-status` 展示当前 workspace、映射、server、remoteRoot、manifest 模式、watcher、最后成功时间和错误。

每轮保留有界审计摘要：原因、generation、上传/删除/保护路径、校验数量、结果和错误；不保存文件内容或凭据，不持续注入会话上下文。

## 21. 资源上限

默认：

```text
最大文件数 20,000
单文件 100 MB
单轮总数据量 2 GB
最大深度 64
最大符号链接 1,000
```

超限即失败，不默默跳过、不报告一致，也不继续依赖最新代码的远程命令。同步进度分阶段显示本地扫描、远端扫描、上传、删除、校验和修复。

## 22. 生命周期

- factory 不启动长期资源。
- `session_start` 后恢复本地映射或现有完整远程工作区。
- watcher、定时器、队列、连接池均在 `session_shutdown` 幂等关闭。
- reload 后旧实例停止，避免双 watcher；新实例重新完整同步。
- 不破坏 Background Tasks 的 ControlMaster lease。
- 配置编辑、映射切换和同步任务使用不可变快照与 generation，旧结果不得覆盖新状态。

## 23. 测试策略

所有实现采用测试驱动开发。

### 23.1 单元测试

- 服务器和映射配置规范化、原子写入、版本和 canonical path。
- Git 清单、未跟踪文件、ignore、删除、重命名和仓库子目录。
- 非 Git 文件扫描、ignore、敏感内容、环境模板和资源限制。
- 安全/越界/循环符号链接及 Windows 权限失败。
- marker 缺失、损坏、ID/root 不匹配和 marker symlink；失败时零写入/删除。
- Unix/Windows 危险根与安全子目录。
- 同步计划、严格删除、保护路径祖先、类型冲突和临时替换。
- 同大小不同内容、远端人工漂移、修复和二次校验失败。
- watcher 防抖、请求合并、同步中变化、polling 退化、pause/resume/shutdown。
- `ssh_exec` 默认目标/cwd、同步屏障、超时、取消、截断、非零退出码和 `require_synced: false`。

### 23.2 最高优先级模式隔离测试

1. 本地同步或 `ssh_exec` 后，文件与 bash 工具仍本地。
2. 独立连接失败不触发完整远程 `Disconnected`。
3. `/ssh-connect` 暂停 watcher。
4. 完整远程断线继续失败关闭。
5. `/ssh-exit` 重新完整同步并恢复 watcher。
6. `/tree` 不混淆状态。
7. `ssh_sync` 在完整远程模式拒绝。
8. 完整远程文件工具不访问本地镜像根。

### 23.3 集成测试

- localhost Unix SSH：授权、marker、上传/覆盖/删除、保护 `.env`、人工漂移、校验修复、watcher 和执行屏障。
- Windows SSH：PowerShell 临时文件替换、Unicode、严格删除、保护、链接权限失败和进程树取消。
- OpenSSH、ssh2、ProxyJump、密码提示去重和断线恢复。
- 测试数据继续遵循隐私检查，不恢复已删除的旧 E2E smoke 文件。

## 24. 兼容与迁移

升级默认不改变现有用户行为：没有服务器和映射时不启动 watcher、不同步、不自动连接，现有 `/ssh-connect`、会话状态、密码缓存、AI 控制工具和 Background Tasks 保持原样。

新增能力只有在用户显式 `/ssh add` 和 `/ssh map add` 后启用。

首版不自动导入参考插件 `ssh-configs.json`，避免明文密码和语义不一致；后续可提供显式 `/ssh import`，只导入非敏感元数据，不导入密码。

## 25. 分阶段交付

1. **服务器与映射**：配置、管理命令、连接测试和状态展示。
2. **严格镜像核心**：清单、排除、marker、危险根、上传/删除、链接、完整校验和 `ssh_sync`。
3. **Watcher 与队列**：防抖、首次同步、pause/resume、Footer 和生命周期。
4. **独立远程执行**：`ssh_exec`、列表、连接池、屏障、权限和动态 Agent 指导。
5. **集成加固**：Unix/Windows/ProxyJump/密码、模式隔离、性能、文档、构建和发布审计。

每阶段都必须保持现有 `/ssh-connect` 回归测试通过。

## 26. 最终验收场景

### 26.1 本地开发与远程验证

Pi-Web 打开已有映射的本地项目：插件立即完整同步并启动 watcher；Agent 在本地修改代码；变化防抖后自动严格镜像并校验；Agent 主动使用 `ssh_exec` 远程测试；失败后远端排障、本地修复、自动再同步和再验证。用户无需提醒同步或远程测试。

### 26.2 完整远程开发

用户 `/ssh-connect devbox:/srv/project`：watcher 暂停；文件、搜索、补全和 Shell 全部远程化；不使用 `ssh_sync`；`/ssh-exit` 后恢复本地首次完整同步和 watcher。

### 26.3 模式不能混淆

本地调用 `ssh_exec` 后读取 `README.md` 必须仍读取本地文件；独立服务器不可达只使该次工具失败，不将工作区变为完整远程断线状态。

### 26.4 严格一致性

本地删除代码后远端对应非保护项自动删除；远端人工修改即使大小不变也会在完整校验中发现、覆盖并二次验证；二次仍漂移则阻止测试。

### 26.5 保护路径

远端 `.env`、依赖、日志、上传和运行时目录不上传、不覆盖、不删除；其祖先目录保留。除保护范围和 marker 外，远端镜像与本地同步清单完全一致。
