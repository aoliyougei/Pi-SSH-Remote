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
      if (!value) throw new Error(`SSH server not found: ${requested}. Use ssh_list_servers.`);
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
    throw new Error("Multiple SSH servers are available; specify server or use ssh_list_servers.");
  }

  async execute(
    request: RemoteExecRequest,
    ctx: ExtensionContext,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<any>,
  ): Promise<AgentToolResult<RemoteExecDetails>> {
    if (!request.command.trim()) throw new Error("ssh_exec command cannot be empty");
    const mapping = this.options.isFullRemoteWorkspace() ? undefined : this.options.mappings.find(ctx.cwd);
    if (mapping && !ctx.isProjectTrusted()) throw new Error("The current project is not trusted; mapping-driven remote execution is disabled");
    if (this.options.isFullRemoteWorkspace() && !request.server) throw new Error("Specify server explicitly when using ssh_exec from a full SSH workspace");
    const server = this.resolveServer(request.server, mapping);
    const mapped = mapping?.serverId === server.id;
    const cwd = request.cwd ?? (mapped ? mapping.remoteRoot : undefined);
    const mirrorRequired = request.require_synced ?? (mapped && !!cwd);
    let mirrorVerified = false;
    if (mirrorRequired) {
      if (!mapping || !mapped) throw new Error("A synchronized project mapping is required for this remote execution");
      const queue = this.options.getMirrorQueue(mapping);
      if (!queue) throw new Error("Remote execution blocked because the project mirror is unavailable");
      onUpdate?.({ content: [{ type: "text", text: "Waiting for project mirror synchronization..." }], details: { phase: "mirror" } });
      if (queue.status.state === "dirty" || queue.status.state === "initializing" || queue.status.state === "failed") {
        await queue.requestSync({ reason: "exec-barrier", immediate: true });
      } else await queue.waitUntilSettled(signal);
      if (queue.status.state !== "synced") throw new Error(`Remote execution blocked because the project mirror is not synchronized: ${queue.status.lastError ?? queue.status.state}`);
      mirrorVerified = true;
    }
    const policy = this.options.getConfirmationPolicy();
    if (requiresExecConfirmation(policy, request.command)) {
      if (!ctx.hasUI) throw new Error("Remote command requires user confirmation, but no UI is available");
      const confirmed = await ctx.ui.confirm("Confirm remote command", `Server: ${server.name}\nTarget: ${server.target}\nRemote cwd: ${cwd ?? "login directory"}\nMirror verified: ${mirrorVerified ? "yes" : "no"}\n\n${request.command}`);
      if (!confirmed) throw new Error("Remote command was not confirmed");
    }
    const lease = await this.options.connections.acquire(server, ctx, signal);
    try {
      const remoteCwd = cwd
        ? lease.adapter.fromToolPath(lease.adapter.toToolPath(cwd, lease.workspace))
        : lease.workspace.cwd;
      const stdout: Buffer[] = [], stderr: Buffer[] = [];
      onUpdate?.({ content: [{ type: "text", text: `Executing on ${server.name}:${remoteCwd}...` }], details: { phase: "execute" } });
      const exitCode = await lease.adapter.runShell(request.command, remoteCwd, {
        signal,
        timeoutSeconds: request.timeout ?? this.options.getDefaultTimeout(),
        captureOutput: false,
        onStdout: (data) => stdout.push(Buffer.from(data)),
        onStderr: (data) => stderr.push(Buffer.from(data)),
      });
      const raw = [
        `Server: ${server.name}`,
        `Target: ${server.target}${server.port ? `:${server.port}` : ""}`,
        `Remote cwd: ${remoteCwd}`,
        `Command: ${request.command}`,
        `Exit code: ${exitCode ?? "signal"}`,
        !mirrorVerified && mapping?.serverId === server.id ? "Warning: current project mirror is not synchronized." : "",
        stdout.length ? `\nstdout:\n${Buffer.concat(stdout).toString("utf8")}` : "",
        stderr.length ? `\nstderr:\n${Buffer.concat(stderr).toString("utf8")}` : "",
      ].filter(Boolean).join("\n");
      const truncation = truncateTail(raw);
      return {
        content: [{ type: "text", text: truncation.content + (truncation.truncated ? "\n\n[Remote output truncated to the last 50KB/2000 lines.]" : "") }],
        details: { serverId: server.id, serverName: server.name, target: server.target, remoteCwd, platform: lease.workspace.platform, shell: lease.workspace.shell, transport: lease.client.transport, exitCode, mirrorRequired, mirrorVerified, truncation: truncation.truncated ? truncation : undefined },
      };
    } finally { await lease.release(); }
  }
}
