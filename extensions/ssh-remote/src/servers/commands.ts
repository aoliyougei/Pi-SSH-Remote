import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, rmSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SshShellPreference } from "../adapters/types.ts";
import type { MappingController } from "../mappings/controller.ts";
import { DEFAULT_REMOTE_PROTECTED_PATTERNS, type LocalProjectMapping } from "../mappings/types.ts";
import type { SshTransportPreference } from "../transport/client.ts";
import { expandLocalPath, parseSshTarget } from "../workspace/target.ts";
import type { ServerConnectionPool } from "./connection-pool.ts";
import type { ServerController } from "./controller.ts";
import { getDefaultOpenSshConfigPath, getManagedKeyPath, isManagedKeyPath, stageManagedKey, type ManagedKeyTransaction } from "./managed-key.ts";
import type { SavedSshServer, SshAuthenticationPreference } from "./types.ts";

export interface SshManagementCommandDependencies {
  servers: ServerController;
  mappings: MappingController;
  connections: ServerConnectionPool;
  isFullRemoteWorkspace(): boolean;
  authorizeMapping?(mapping: LocalProjectMapping, ctx: ExtensionCommandContext): Promise<void>;
  replaceMapping?(current: LocalProjectMapping, candidate: LocalProjectMapping, ctx: ExtensionCommandContext): Promise<void>;
  removeMapping?(mapping: LocalProjectMapping, ctx: ExtensionCommandContext): Promise<void>;
  pauseMapping?(mapping: LocalProjectMapping, ctx: ExtensionCommandContext): Promise<void>;
  resumeMapping?(mapping: LocalProjectMapping, ctx: ExtensionCommandContext): Promise<void>;
  syncMapping?(ctx: ExtensionCommandContext): Promise<void>;
  onServersChanged?(): void;
  managedKeyDirectory?: string;
}

function displayTarget(server: SavedSshServer): string {
  return `${server.target}${server.port === undefined ? "" : `:${server.port}`}`;
}

function parsePort(value: string | undefined): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (!/^\d+$/.test(text)) throw new Error("SSH 端口必须是 1 到 65535 之间的整数");
  const port = Number(text);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("SSH 端口必须是 1 到 65535 之间的整数");
  return port;
}

async function selectServer(
  ctx: ExtensionContext,
  servers: readonly SavedSshServer[],
  requested?: string,
): Promise<SavedSshServer | undefined> {
  if (requested) return servers.find((server) => server.name.toLocaleLowerCase("en-US") === requested.toLocaleLowerCase("en-US"));
  if (!ctx.hasUI) return undefined;
  const labels = servers.map((server) => `${server.name} — ${displayTarget(server)}${server.description ? ` — ${server.description}` : ""}`);
  const selected = await ctx.ui.select("选择 SSH 服务器", labels);
  const index = selected ? labels.indexOf(selected) : -1;
  return index >= 0 ? servers[index] : undefined;
}

async function testServer(
  server: SavedSshServer,
  ctx: ExtensionContext,
  connections: ServerConnectionPool,
): Promise<string> {
  const lease = await connections.acquire(server, ctx);
  try {
    return [
      `服务器：${server.name}`,
      `目标：${displayTarget(server)}`,
      "状态：可连接",
      `平台：${lease.workspace.platform}`,
      `Shell：${lease.workspace.shell}`,
      `传输方式：${lease.client.transport ?? "custom"}${lease.client.reusesConnection === undefined ? "" : lease.client.reusesConnection ? "（复用连接）" : "（单次连接）"}`,
      `主目录：${lease.workspace.home}`,
      `登录目录：${lease.workspace.cwd}`,
    ].join("\n");
  } finally {
    await lease.release();
  }
}

async function addServer(
  ctx: ExtensionContext,
  dependencies: SshManagementCommandDependencies,
): Promise<void> {
  if (!ctx.hasUI) throw new Error("/ssh add 需要交互式界面");
  const name = (await ctx.ui.input("服务器名称", "test-api"))?.trim();
  if (!name) return;
  const description = (await ctx.ui.input("描述（可选）", ""))?.trim() || undefined;
  const rawTarget = (await ctx.ui.input("SSH 目标或 OpenSSH 别名", "deploy@devbox"))?.trim();
  if (!rawTarget) return;
  const parsed = parseSshTarget(rawTarget);
  if (parsed.requestedCwd) throw new Error("已保存服务器不能包含远端项目路径，请使用 /ssh map add 配置");
  const enteredPort = await ctx.ui.input("显式端口（可选）", parsed.port === undefined ? "" : String(parsed.port));
  const port = parsePort(enteredPort) ?? parsed.port;
  const defaultConfig = getDefaultOpenSshConfigPath();
  const configInput = (await ctx.ui.input("本地 OpenSSH 配置文件", defaultConfig))?.trim();
  if (configInput === undefined) return;
  const configFile = expandLocalPath(configInput || defaultConfig, ctx.cwd);
  const authenticationLabel = await ctx.ui.select("认证方式", ["密码认证", "密钥认证"]);
  if (!authenticationLabel) return;
  const authenticationPreference: SshAuthenticationPreference = authenticationLabel === "密码认证" ? "password" : "key";
  let password: string | undefined;
  let keyTransaction: ManagedKeyTransaction | undefined;
  let identityFile: string | undefined;
  if (authenticationPreference === "password") {
    password = await ctx.ui.input("SSH 密码", "请输入 SSH 密码");
    if (!password) throw new Error("SSH 密码不能为空");
  } else {
    const keyName = (await ctx.ui.input("托管密钥文件名", "id_ed25519_test"))?.trim();
    if (!keyName) return;
    identityFile = getManagedKeyPath(keyName, dependencies.managedKeyDirectory);
    if (existsSync(identityFile)) {
      const references = dependencies.servers.list().filter((server) => server.identityFile === identityFile).map((server) => server.name);
      const warning = references.length ? `\n该密钥还被以下服务器引用：${references.join("、")}` : "";
      if (!await ctx.ui.confirm("覆盖托管密钥", `密钥文件 ${identityFile} 已存在，是否覆盖？${warning}`)) return;
    }
    const keyContents = await ctx.ui.editor("粘贴私钥", "");
    if (!keyContents) return;
    keyTransaction = await stageManagedKey(keyName, keyContents, dependencies.managedKeyDirectory);
  }
  try {
    const shellLabel = await ctx.ui.select("远端 Shell", ["auto（自动）", "bash", "zsh", "pwsh", "powershell"]);
    if (!shellLabel) { await keyTransaction?.rollback(); return; }
    const transportLabel = await ctx.ui.select("SSH 传输方式", ["auto（自动）", "openssh", "ssh2"]);
    if (!transportLabel) { await keyTransaction?.rollback(); return; }
    const timestamp = new Date().toISOString();
    const server: SavedSshServer = {
      version: 1,
      id: randomUUID(),
      name,
      description,
      target: parsed.target,
      port,
      configFile,
      authenticationPreference,
      identityFile,
      shellPreference: shellLabel.replace("（自动）", "") as SshShellPreference,
      transportPreference: transportLabel.replace("（自动）", "") as SshTransportPreference,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    if (password) await dependencies.connections.rememberPassword(server, password);
    ctx.ui.notify(`正在测试 ${server.name}…`, "info");
    const status = await testServer(server, ctx, dependencies.connections);
    dependencies.servers.add(server);
    keyTransaction?.commit();
    dependencies.onServersChanged?.();
    ctx.ui.notify(`${status}\n\n已保存 SSH 服务器：${server.name}`, "info");
  } catch (error) {
    await keyTransaction?.rollback();
    throw error;
  }
}

async function editServer(
  requested: string | undefined,
  ctx: ExtensionContext,
  dependencies: SshManagementCommandDependencies,
): Promise<void> {
  if (!ctx.hasUI) throw new Error("/ssh edit 需要交互式界面");
  const original = await selectServer(ctx, dependencies.servers.list(), requested);
  if (!original) throw new Error(requested ? `未找到 SSH 服务器：${requested}` : "未选择 SSH 服务器");
  const name = (await ctx.ui.input(`服务器名称（当前：${original.name}）`, original.name))?.trim() || original.name;
  const descriptionInput = await ctx.ui.input(`描述（当前：${original.description ?? "无"}；输入 - 清除）`, original.description ?? "");
  const description = descriptionInput?.trim() === "-" ? undefined : descriptionInput?.trim() || original.description;
  const targetInput = (await ctx.ui.input(`SSH 目标（当前：${original.target}）`, original.target))?.trim() || original.target;
  const parsed = parseSshTarget(targetInput);
  if (parsed.requestedCwd) throw new Error("已保存服务器不能包含远端项目路径");
  const port = parsePort(await ctx.ui.input(`端口（当前：${original.port ?? "配置值/默认值"}）`, original.port === undefined ? "" : String(original.port))) ?? parsed.port;
  const configInput = (await ctx.ui.input(`本地 OpenSSH 配置文件（当前：${original.configFile ?? "默认"}；输入 - 清除）`, original.configFile ?? getDefaultOpenSshConfigPath()))?.trim();
  const configFile = configInput === "-" ? undefined : configInput ? expandLocalPath(configInput, ctx.cwd) : original.configFile;
  const authLabel = await ctx.ui.select("认证方式", ["保持当前认证", "密码认证", "密钥认证"]);
  if (!authLabel) return;
  let authenticationPreference = original.authenticationPreference;
  let identityFile = original.identityFile;
  let password: string | undefined;
  let keyTransaction: ManagedKeyTransaction | undefined;
  if (authLabel === "密码认证") {
    authenticationPreference = "password";
    identityFile = undefined;
    password = await ctx.ui.input("SSH 密码", "请输入 SSH 密码");
    if (!password) throw new Error("SSH 密码不能为空");
  } else if (authLabel === "密钥认证") {
    authenticationPreference = "key";
    const keyName = (await ctx.ui.input("托管密钥文件名", original.identityFile?.split(/[\\/]/).at(-1) ?? "id_ed25519_test"))?.trim();
    if (!keyName) return;
    identityFile = getManagedKeyPath(keyName, dependencies.managedKeyDirectory);
    if (existsSync(identityFile)) {
      const references = dependencies.servers.list().filter((server) => server.id !== original.id && server.identityFile === identityFile).map((server) => server.name);
      const warning = references.length ? `\n该密钥还被以下服务器引用：${references.join("、")}` : "";
      if (!await ctx.ui.confirm("覆盖托管密钥", `密钥文件 ${identityFile} 已存在，是否覆盖？${warning}`)) return;
    }
    const keyContents = await ctx.ui.editor("粘贴私钥", "");
    if (!keyContents) return;
    keyTransaction = await stageManagedKey(keyName, keyContents, dependencies.managedKeyDirectory);
  }
  try {
    const shell = await ctx.ui.select("远端 Shell", ["auto（自动）", "bash", "zsh", "pwsh", "powershell"]);
    if (!shell) { await keyTransaction?.rollback(); return; }
    const transport = await ctx.ui.select("SSH 传输方式", ["auto（自动）", "openssh", "ssh2"]);
    if (!transport) { await keyTransaction?.rollback(); return; }
    const candidate: SavedSshServer = {
      ...original, name, description, target: parsed.target, port, configFile,
      authenticationPreference, identityFile,
      shellPreference: shell.replace("（自动）", "") as SshShellPreference,
      transportPreference: transport.replace("（自动）", "") as SshTransportPreference,
      updatedAt: new Date().toISOString(),
    };
    if (password) await dependencies.connections.rememberPassword(candidate, password);
    const status = await testServer(candidate, ctx, dependencies.connections);
    dependencies.servers.update(original.id, candidate);
    keyTransaction?.commit();
    await dependencies.connections.invalidate(original.id);
    dependencies.onServersChanged?.();
    ctx.ui.notify(`${status}\n\n已更新 SSH 服务器：${candidate.name}`, "info");
  } catch (error) {
    await keyTransaction?.rollback();
    throw error;
  }
}

async function removeServer(
  requested: string | undefined,
  ctx: ExtensionContext,
  dependencies: SshManagementCommandDependencies,
): Promise<void> {
  const server = await selectServer(ctx, dependencies.servers.list(), requested);
  if (!server) throw new Error(requested ? `未找到 SSH 服务器：${requested}` : "未选择 SSH 服务器");
  const mappings = dependencies.mappings.list().filter((mapping) => mapping.serverId === server.id);
  if (!ctx.hasUI) throw new Error("/ssh rm 需要交互式确认");
  const message = mappings.length > 0
    ? `${server.name} 被 ${mappings.length} 个项目映射引用。是否删除该服务器及这些本地映射？远端文件和 marker 不会删除。`
    : `是否删除已保存的 SSH 服务器 ${server.name}？远端文件和 SSH 凭据不会删除。`;
  if (!await ctx.ui.confirm("删除 SSH 服务器", message)) return;
  let removeManagedKey = false;
  if (server.identityFile && isManagedKeyPath(server.identityFile, dependencies.managedKeyDirectory)) {
    const shared = dependencies.servers.list().some((candidate) => candidate.id !== server.id && candidate.identityFile === server.identityFile);
    if (!shared) removeManagedKey = await ctx.ui.confirm("删除托管密钥", `是否同时删除托管密钥 ${server.identityFile}？`);
  }
  for (const mapping of mappings) dependencies.mappings.remove(mapping.id);
  dependencies.servers.remove(server.id);
  await dependencies.connections.invalidate(server.id);
  if (removeManagedKey && server.identityFile) {
    try {
      const stat = lstatSync(server.identityFile);
      if (stat.isFile() && !stat.isSymbolicLink()) rmSync(server.identityFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") ctx.ui.notify(`服务器已删除，但托管密钥删除失败：${error instanceof Error ? error.message : String(error)}`, "warning");
    }
  }
  dependencies.onServersChanged?.();
  ctx.ui.notify(`已删除 SSH 服务器：${server.name}`, "info");
}

function listServers(dependencies: SshManagementCommandDependencies): string {
  const servers = dependencies.servers.list();
  if (servers.length === 0) return "没有已保存的 SSH 服务器，请使用 /ssh add。";
  return ["SSH 服务器：", ...servers.flatMap((server) => {
    const mappings = dependencies.mappings.list().filter((mapping) => mapping.serverId === server.id).length;
    return [
      "",
      server.name,
      ...(server.description ? [`  描述：${server.description}`] : []),
      `  目标：${displayTarget(server)}`,
      `  Shell：${server.shellPreference}`,
      `  传输方式：${server.transportPreference}`,
      `  已映射项目：${mappings}`,
    ];
  })].join("\n");
}

export function registerSshManagementCommands(
  pi: ExtensionAPI,
  dependencies: SshManagementCommandDependencies,
): void {
  pi.registerCommand("ssh", {
    description: "管理已保存的 SSH 服务器和本地项目镜像",
    handler: async (rawArgs, ctx) => {
      const [command = "", ...rest] = rawArgs.trim().split(/\s+/).filter(Boolean);
      const argument = rest.join(" ") || undefined;
      try {
        if (["add", "new", "edit", "rm", "remove", "delete"].includes(command.toLowerCase())) {
          await ctx.waitForIdle();
        }
        if (!command) {
          if (!ctx.hasUI) throw new Error("非交互模式请使用 /ssh add|edit|rm|ls|test");
          const selected = await ctx.ui.select("服务器管理", ["列出服务器", "添加服务器", "编辑服务器", "删除服务器", "测试服务器"]);
          const routed = selected === "列出服务器" ? "ls" : selected === "添加服务器" ? "add" : selected === "编辑服务器" ? "edit" : selected === "删除服务器" ? "rm" : selected === "测试服务器" ? "test" : undefined;
          if (!routed) return;
          await route(routed, undefined, ctx, dependencies);
          return;
        }
        await route(command.toLowerCase(), argument, ctx, dependencies);
      } catch (error) {
        ctx.ui.notify(`操作失败：${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}

async function route(
  command: string,
  argument: string | undefined,
  ctx: ExtensionCommandContext,
  dependencies: SshManagementCommandDependencies,
): Promise<void> {
  if (command === "add" || command === "new") return addServer(ctx, dependencies);
  if (command === "edit") return editServer(argument, ctx, dependencies);
  if (command === "rm" || command === "remove" || command === "delete") return removeServer(argument, ctx, dependencies);
  if (command === "ls" || command === "list") {
    ctx.ui.notify(listServers(dependencies), "info");
    return;
  }
  if (command === "test") {
    const server = await selectServer(ctx, dependencies.servers.list(), argument);
    if (!server) throw new Error(argument ? `未找到 SSH 服务器：${argument}` : "未选择 SSH 服务器");
    ctx.ui.notify(await testServer(server, ctx, dependencies.connections), "info");
    return;
  }
  if (command === "map") {
    if (dependencies.isFullRemoteWorkspace()) throw new Error("项目映射只能在本地工作区管理，请先使用 /ssh-exit");
    const [action = "show"] = (argument ?? "show").split(/\s+/);
    const existing = dependencies.mappings.find(ctx.cwd);
    if (action === "show") {
      if (!existing) { ctx.ui.notify("当前本地项目未配置远端镜像，请使用 /ssh map add。", "info"); return; }
      const server = dependencies.servers.get(existing.serverId);
      ctx.ui.notify(`项目镜像\n本地根目录：${existing.localRoot}\n服务器：${server?.name ?? "缺失"}\n远端根目录：${existing.remoteRoot}\n自动同步：${existing.autoSync ? "已启用" : "已禁用"}\n已暂停：${existing.paused ? "是" : "否"}`, "info");
      return;
    }
    await ctx.waitForIdle();
    if (action === "add") {
      if (existing) throw new Error("当前本地项目已有映射，请先删除或编辑该映射");
      if (!ctx.hasUI) throw new Error("/ssh map add 需要交互式界面");
      const server = await selectServer(ctx, dependencies.servers.list());
      if (!server) throw new Error("未选择 SSH 服务器，请先使用 /ssh add");
      const remoteRoot = (await ctx.ui.input("远端镜像目录", "/srv/test/project"))?.trim();
      if (!remoteRoot) return;
      const timestamp = new Date().toISOString();
      const mapping: LocalProjectMapping = { version: 1, id: randomUUID(), projectId: randomUUID(), localRoot: ctx.cwd, localRootCanonical: ctx.cwd, matchSubdirectories: true, serverId: server.id, remoteRoot, autoSync: true, debounceMs: 1500, localExcludePatterns: [], remoteProtectedPatterns: [...DEFAULT_REMOTE_PROTECTED_PATTERNS], markerId: randomUUID(), paused: false, createdAt: timestamp, updatedAt: timestamp };
      if (!dependencies.authorizeMapping) throw new Error("项目镜像子系统不可用");
      await dependencies.authorizeMapping(mapping, ctx);
      return;
    }
    if (!existing) throw new Error("当前本地项目未配置远端镜像");
    if (action === "edit") {
      if (!ctx.hasUI) throw new Error("/ssh map edit 需要交互式界面");
      const server = await selectServer(ctx, dependencies.servers.list());
      if (!server) throw new Error("映射的 SSH 服务器不可用");
      const remoteRoot = (await ctx.ui.input(`远端镜像目录（当前：${existing.remoteRoot}）`, existing.remoteRoot))?.trim() || existing.remoteRoot;
      const localExcludeText = await ctx.ui.input("额外本地排除项（逗号分隔）", existing.localExcludePatterns.join(","));
      const protectedText = await ctx.ui.input("远端保护路径（逗号分隔）", existing.remoteProtectedPatterns.join(","));
      const debounceText = await ctx.ui.input("防抖毫秒数（250-30000）", String(existing.debounceMs));
      const debounceMs = Number(debounceText ?? existing.debounceMs);
      if (!Number.isInteger(debounceMs) || debounceMs < 250 || debounceMs > 30_000) throw new Error("镜像防抖时间必须为 250 到 30000 毫秒");
      const split = (value: string | undefined) => (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
      const candidate: LocalProjectMapping = { ...existing, serverId: server.id, remoteRoot, localExcludePatterns: split(localExcludeText), remoteProtectedPatterns: split(protectedText), debounceMs, updatedAt: new Date().toISOString(), ...(server.id !== existing.serverId || remoteRoot !== existing.remoteRoot ? { markerId: randomUUID() } : {}) };
      await dependencies.replaceMapping?.(existing, candidate, ctx);
      return;
    }
    if (action === "rm" || action === "remove") { await dependencies.removeMapping?.(existing, ctx); return; }
    if (action === "pause") { await dependencies.pauseMapping?.(existing, ctx); return; }
    if (action === "resume") { await dependencies.resumeMapping?.(existing, ctx); return; }
    throw new Error("用法：/ssh map [add|show|edit|rm|pause|resume]");
  }
  if (command === "sync") { await ctx.waitForIdle(); await dependencies.syncMapping?.(ctx); return; }
  if (command === "config") {
    ctx.ui.notify("请使用 /aoliyougei-settings 并打开 SSH Remote 设置。", "info");
    return;
  }
  throw new Error("用法：/ssh [add|edit|rm|ls|test|config|map|sync]");
}
