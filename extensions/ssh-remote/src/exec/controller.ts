import { truncateTail, type AgentToolResult, type AgentToolUpdateCallback, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { LocalProjectMapping } from "../mappings/types.ts";
import type { MappingController } from "../mappings/controller.ts";
import type { MirrorQueue } from "../sync/queue.ts";
import type { ServerConnectionPool } from "../servers/connection-pool.ts";
import type { ServerController } from "../servers/controller.ts";
import type { SavedSshServer } from "../servers/types.ts";
import { requiresExecConfirmation, type ExecConfirmationPolicy } from "./policy.ts";

export interface RemoteExecRequest { server?: string; command: string; cwd?: string; timeout?: number; require_synced?: boolean }
export interface RemoteExecDetails { serverId: string; serverName: string; target: string; remoteCwd: string; platform: string; shell: string; transport?: string; exitCode: number | null; mirrorRequired: boolean; mirrorVerified: boolean; truncation?: unknown }

export interface RemoteExecControllerOptions {
  servers: ServerController;
  mappings: MappingController;
  connections: ServerConnectionPool;
  getMirrorQueue(mapping: LocalProjectMapping): MirrorQueue | undefined;
  getDefaultServerId(): string | undefined;
  getConfirmationPolicy(): ExecConfirmationPolicy;
  getDefaultTimeout(): number;
  isFullRemoteWorkspace(): boolean;
}

export class RemoteExecController {
  constructor(private readonly options: RemoteExecControllerOptions) {}

  private resolveServer(requested: string | undefined, mapping: LocalProjectMapping | undefined): SavedSshServer {
    if (requested) {
      const value = this.options.servers.findByName(requested);
      if (!value) throw new Error(`未找到 SSH 服务器：${requested}。请使用 ssh_list_servers。`);
      return value;
    }
    if (mapping) {
      const value = this.options.servers.get(mapping.serverId);
      if (value) return value;
    }
    const defaultId = this.options.getDefaultServerId();
    if (defaultId) {
      const value = this.options.servers.get(defaultId);
      if (value) return value;
    }
    const servers = this.options.servers.list();
    if (servers.length === 1) return servers[0];
    throw new Error("存在多个 SSH 服务器，请指定 server 或使用 ssh_list_servers。");
  }

  async execute(
    request: RemoteExecRequest,
    ctx: ExtensionContext,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<any>,
  ): Promise<AgentToolResult<RemoteExecDetails>> {
    if (!request.command.trim()) throw new Error("ssh_exec 命令不能为空");
    const mapping = this.options.isFullRemoteWorkspace() ? undefined : this.options.mappings.find(ctx.cwd);
    if (mapping && !ctx.isProjectTrusted()) throw new Error("当前项目不受信任，已禁用映射驱动的远程执行");
    if (this.options.isFullRemoteWorkspace() && !request.server) throw new Error("在完整 SSH 工作区中使用 ssh_exec 时必须显式指定 server");
    const server = this.resolveServer(request.server, mapping);
    const mapped = mapping?.serverId === server.id;
    const cwd = request.cwd ?? (mapped ? mapping.remoteRoot : undefined);
    const mirrorRequired = request.require_synced ?? (mapped && !!cwd);
    let mirrorVerified = false;
    if (mirrorRequired) {
      if (!mapping || !mapped) throw new Error("本次远程执行需要已同步的项目映射");
      const queue = this.options.getMirrorQueue(mapping);
      if (!queue) throw new Error("项目镜像不可用，已阻止远程执行");
      onUpdate?.({ content: [{ type: "text", text: "正在等待项目镜像同步…" }], details: { phase: "mirror" } });
      if (queue.status.state === "dirty" || queue.status.state === "initializing" || queue.status.state === "failed") {
        await queue.requestSync({ reason: "exec-barrier", immediate: true });
      } else await queue.waitUntilSettled(signal);
      if (queue.status.state !== "synced") throw new Error(`项目镜像尚未同步，已阻止远程执行：${queue.status.lastError ?? queue.status.state}`);
      mirrorVerified = true;
    }
    const policy = this.options.getConfirmationPolicy();
    if (requiresExecConfirmation(policy, request.command)) {
      if (!ctx.hasUI) throw new Error("远程命令需要用户确认，但当前没有可用界面");
      const confirmed = await ctx.ui.confirm("确认远程命令", `服务器：${server.name}\n目标：${server.target}\n远端 cwd：${cwd ?? "登录目录"}\n镜像已验证：${mirrorVerified ? "是" : "否"}\n\n${request.command}`);
      if (!confirmed) throw new Error("远程命令未获确认");
    }
    const lease = await this.options.connections.acquire(server, ctx, signal);
    try {
      const remoteCwd = cwd
        ? lease.adapter.fromToolPath(lease.adapter.toToolPath(cwd, lease.workspace))
        : lease.workspace.cwd;
      const stdout: Buffer[] = [], stderr: Buffer[] = [];
      onUpdate?.({ content: [{ type: "text", text: `正在 ${server.name}:${remoteCwd} 上执行…` }], details: { phase: "execute" } });
      const exitCode = await lease.adapter.runShell(request.command, remoteCwd, {
        signal,
        timeoutSeconds: request.timeout ?? this.options.getDefaultTimeout(),
        captureOutput: false,
        onStdout: (data) => stdout.push(Buffer.from(data)),
        onStderr: (data) => stderr.push(Buffer.from(data)),
      });
      const raw = [
        `服务器：${server.name}`,
        `目标：${server.target}${server.port ? `:${server.port}` : ""}`,
        `远端 cwd：${remoteCwd}`,
        `命令：${request.command}`,
        `退出码：${exitCode ?? "signal"}`,
        !mirrorVerified && mapping?.serverId === server.id ? "警告：当前项目镜像尚未同步。" : "",
        stdout.length ? `\nstdout:\n${Buffer.concat(stdout).toString("utf8")}` : "",
        stderr.length ? `\nstderr:\n${Buffer.concat(stderr).toString("utf8")}` : "",
      ].filter(Boolean).join("\n");
      const truncation = truncateTail(raw);
      return {
        content: [{ type: "text", text: truncation.content + (truncation.truncated ? "\n\n[远端输出已截断，仅保留最后 50KB/2000 行。]" : "") }],
        details: { serverId: server.id, serverName: server.name, target: server.target, remoteCwd, platform: lease.workspace.platform, shell: lease.workspace.shell, transport: lease.client.transport, exitCode, mirrorRequired, mirrorVerified, truncation: truncation.truncated ? truncation : undefined },
      };
    } finally { await lease.release(); }
  }
}
