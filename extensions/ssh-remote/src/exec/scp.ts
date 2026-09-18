import { spawn } from "node:child_process";
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MappingController } from "../mappings/controller.ts";
import type { ServerConnectionPool } from "../servers/connection-pool.ts";
import type { ServerController } from "../servers/controller.ts";
import type { SavedSshServer } from "../servers/types.ts";

export interface ScpInvocation {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export interface BuildScpInvocationOptions {
  action: "upload" | "download";
  server: SavedSshServer;
  localPath: string;
  remotePath: string;
  recursive?: boolean;
  knownHostsFile: string;
  password?: string;
  platform?: NodeJS.Platform;
}

export function buildScpInvocation(options: BuildScpInvocationOptions): ScpInvocation {
  const { server } = options;
  const platform = options.platform ?? process.platform;
  const scp = platform === "win32" ? "scp.exe" : "scp";
  const args: string[] = [];
  if (server.configFile) args.push("-F", server.configFile);
  args.push(
    "-o", `UserKnownHostsFile=${options.knownHostsFile}`,
    "-o", "GlobalKnownHostsFile=/etc/ssh/ssh_known_hosts",
    "-o", "StrictHostKeyChecking=yes",
  );
  if (server.authenticationPreference === "key") {
    if (!server.identityFile) throw new Error("SCP 密钥认证缺少 identityFile");
    args.push("-i", server.identityFile, "-o", "IdentitiesOnly=no", "-o", "PreferredAuthentications=publickey,password,keyboard-interactive");
  } else if (server.authenticationPreference === "password") {
    args.push("-o", "PreferredAuthentications=password,keyboard-interactive,publickey");
  }
  args.push(
    "-o", `BatchMode=${options.password ? "no" : "yes"}`,
    "-o", "ConnectTimeout=10",
  );
  if (server.port !== undefined) args.push("-P", String(server.port));
  if (options.recursive) args.push("-r");
  const at = server.target.lastIndexOf("@");
  const user = at === -1 ? "" : server.target.slice(0, at + 1);
  const host = at === -1 ? server.target : server.target.slice(at + 1);
  const scpTarget = host.includes(":") && !host.startsWith("[") ? `${user}[${host}]` : server.target;
  const remote = `${scpTarget}:${options.remotePath}`;
  args.push(...(options.action === "upload" ? [options.localPath, remote] : [remote, options.localPath]));
  return options.password
    ? { executable: platform === "win32" ? "sshpass.exe" : "sshpass", args: ["-e", scp, ...args], env: { ...process.env, SSHPASS: options.password } }
    : { executable: scp, args, env: { ...process.env } };
}

export interface ScpRequest {
  action: "upload" | "download";
  server?: string;
  local_path: string;
  remote_path: string;
  recursive?: boolean;
  timeout?: number;
}

export interface ScpDetails {
  serverId: string;
  serverName: string;
  action: "upload" | "download";
  localPath: string;
  remotePath: string;
  recursive: boolean;
  exitCode: number | null;
}

export interface ScpRunnerResult { exitCode: number | null; stderr: Buffer }
export type ScpRunner = (invocation: ScpInvocation, options: { signal?: AbortSignal; timeoutSeconds: number }) => Promise<ScpRunnerResult>;

export function runScpProcess(invocation: ScpInvocation, options: { signal?: AbortSignal; timeoutSeconds: number }): Promise<ScpRunnerResult> {
  if (!Number.isFinite(options.timeoutSeconds) || options.timeoutSeconds <= 0) throw new Error("SCP timeout must be positive");
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.executable, invocation.args, {
      env: invocation.env,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    let settled = false;
    let stderr = Buffer.alloc(0);
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      action();
    };
    const killTree = (): void => {
      if (process.platform === "win32" && child.pid) {
        const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        killer.unref();
        return;
      }
      try { if (child.pid) process.kill(-child.pid, "SIGKILL"); }
      catch { child.kill("SIGKILL"); }
    };
    const abort = (): void => {
      killTree();
      const reason = options.signal?.reason;
      finish(() => reject(reason instanceof Error ? reason : new Error("SCP 传输已取消")));
    };
    const timer = setTimeout(() => {
      killTree();
      finish(() => reject(new Error(`SCP 传输在 ${options.timeoutSeconds} 秒后超时`)));
    }, options.timeoutSeconds * 1_000);
    timer.unref?.();
    child.stderr?.on("data", (data: Buffer) => {
      stderr = Buffer.concat([stderr, data]);
      if (stderr.length > 64 * 1024) stderr = stderr.subarray(stderr.length - 64 * 1024);
    });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (exitCode) => finish(() => resolve({ exitCode, stderr })));
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
  });
}

export interface ScpControllerOptions {
  servers: ServerController;
  mappings: MappingController;
  connections: ServerConnectionPool;
  getDefaultServerId(): string | undefined;
  knownHostsFile: string;
  run: ScpRunner;
  platform?: NodeJS.Platform;
  isFullRemoteWorkspace?(): boolean;
}

function inside(root: string, path: string): boolean {
  const value = relative(root, path);
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

function verifyRecursiveLinks(root: string, start: string): void {
  const pending = [start];
  const visited = new Set<string>();
  while (pending.length) {
    const directory = realpathSync(pending.pop()!);
    if (visited.has(directory)) continue;
    visited.add(directory);
    for (const name of readdirSync(directory)) {
      const entry = resolve(directory, name);
      if (lstatSync(entry).isSymbolicLink()) {
        const target = realpathSync(entry);
        if (!inside(root, target)) throw new Error(`SCP 递归目录中的符号链接位于项目目录之外：${entry}`);
        if (statSync(target).isDirectory()) pending.push(target);
      } else if (lstatSync(entry).isDirectory()) pending.push(entry);
    }
  }
}

function resolveLocalPath(root: string, input: string, mustExist: boolean): string {
  if (!input || /[\0\r\n]/.test(input)) throw new Error("SCP 本地路径无效");
  const rootPath = realpathSync(root);
  const target = resolve(rootPath, input);
  if (mustExist) {
    if (!existsSync(target)) throw new Error(`SCP 本地上传源不存在：${input}`);
    const actual = realpathSync(target);
    if (!inside(rootPath, actual)) throw new Error("SCP 本地路径位于当前项目目录之外");
    return actual;
  }
  let ancestor = target;
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const actualAncestor = realpathSync(ancestor);
  if (!inside(rootPath, actualAncestor)) throw new Error("SCP 本地路径位于当前项目目录之外");
  if (existsSync(target) && !inside(rootPath, realpathSync(target))) throw new Error("SCP 本地路径位于当前项目目录之外");
  return target;
}

export class ScpController {
  constructor(private readonly options: ScpControllerOptions) {}

  private resolveServer(requested: string | undefined, cwd: string): SavedSshServer {
    if (requested) {
      const server = this.options.servers.findByName(requested);
      if (!server) throw new Error(`未找到 SSH 服务器：${requested}。请使用 ssh_list_servers。`);
      return server;
    }
    const mapping = this.options.mappings.find(cwd);
    if (mapping) {
      const server = this.options.servers.get(mapping.serverId);
      if (server) return server;
    }
    const defaultId = this.options.getDefaultServerId();
    if (defaultId) {
      const server = this.options.servers.get(defaultId);
      if (server) return server;
    }
    const servers = this.options.servers.list();
    if (servers.length === 1) return servers[0];
    throw new Error("存在多个 SSH 服务器，请指定 server 或使用 ssh_list_servers。");
  }

  async execute(request: ScpRequest, ctx: ExtensionContext, signal?: AbortSignal): Promise<AgentToolResult<ScpDetails>> {
    if (this.options.isFullRemoteWorkspace?.()) throw new Error("完整 SSH 工作区中不能使用 ssh_scp；请先返回本地项目工作区");
    if (!ctx.isProjectTrusted()) throw new Error("当前项目不受信任，已禁用 SCP 文件传输");
    if (!request.remote_path || !/^[A-Za-z0-9_./~@%+=,:-]+$/.test(request.remote_path)) throw new Error("SCP 远端路径只能使用安全字符：字母、数字、_./~@%+=,:-");
    const projectRoot = realpathSync(ctx.cwd);
    const localPath = resolveLocalPath(projectRoot, request.local_path, request.action === "upload");
    if (request.action === "upload" && lstatSync(localPath).isDirectory() && !request.recursive) throw new Error("上传目录必须设置 recursive=true");
    if (request.recursive && existsSync(localPath) && statSync(localPath).isDirectory()) verifyRecursiveLinks(projectRoot, localPath);
    const server = this.resolveServer(request.server, ctx.cwd);
    const lease = await this.options.connections.acquire(server, ctx, signal);
    try {
      const password = await this.options.connections.cachedPassword?.(server);
      const result = await this.options.run(buildScpInvocation({
        action: request.action,
        server,
        localPath,
        remotePath: request.remote_path,
        recursive: request.recursive,
        knownHostsFile: this.options.knownHostsFile,
        password,
        platform: this.options.platform,
      }), { signal, timeoutSeconds: request.timeout ?? 120 });
      if (result.exitCode !== 0) {
        const detail = result.stderr.toString("utf8").trim().slice(0, 4_000);
        throw new Error(`SCP 传输失败（退出码 ${result.exitCode ?? "signal"}）${detail ? `：${detail}` : ""}`);
      }
      const verb = request.action === "upload" ? "上传" : "下载";
      return {
        content: [{ type: "text", text: `SCP ${verb}完成\n服务器：${server.name}\n本地：${localPath}\n远端：${request.remote_path}` }],
        details: { serverId: server.id, serverName: server.name, action: request.action, localPath, remotePath: request.remote_path, recursive: request.recursive ?? false, exitCode: result.exitCode },
      };
    } finally { await lease.release(); }
  }
}
