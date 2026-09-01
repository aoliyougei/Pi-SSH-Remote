import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { LocalProjectMapping } from "../mappings/types.ts";
import type { MappingController } from "../mappings/controller.ts";
import type { MirrorQueue } from "../sync/queue.ts";
import type { ServerController } from "../servers/controller.ts";
import type { RemoteExecController } from "./controller.ts";

const TOOL_NAMES = new Set(["ssh_list_servers", "ssh_exec", "ssh_sync"]);
export interface RemoteExecutionToolState { enabled: boolean; trusted: boolean; fullRemote: boolean; hasServers: boolean; hasMapping: boolean }

export function syncRemoteExecutionActiveTools(pi: ExtensionAPI, state: RemoteExecutionToolState): void {
  const base = pi.getActiveTools().filter((name) => !TOOL_NAMES.has(name));
  const next = [...base];
  if (state.enabled && state.hasServers) next.push("ssh_list_servers", "ssh_exec");
  if (state.enabled && state.hasMapping && state.trusted && !state.fullRemote) next.push("ssh_sync");
  const current = pi.getActiveTools();
  if (current.length !== next.length || current.some((value, index) => value !== next[index])) pi.setActiveTools(next);
}

export interface RemoteExecutionToolDependencies {
  controller: RemoteExecController;
  servers: ServerController;
  mappings: MappingController;
  getMirrorQueue(mapping: LocalProjectMapping): MirrorQueue | undefined;
  isFullRemoteWorkspace(): boolean;
}

export function registerRemoteExecutionTools(pi: ExtensionAPI, dependencies: RemoteExecutionToolDependencies): void {
  pi.registerTool({
    name: "ssh_list_servers", label: "SSH Servers",
    description: "List saved SSH servers available for independent remote execution without changing the current workspace.",
    promptSnippet: "List saved remote execution servers when the target is unclear",
    promptGuidelines: ["Use ssh_list_servers only when the remote execution target is unclear; a mapped local project already identifies its default server."],
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const mapping = dependencies.isFullRemoteWorkspace() ? undefined : dependencies.mappings.find(ctx.cwd);
      const lines = ["SSH servers:"];
      for (const server of dependencies.servers.list()) lines.push("", server.name, ...(server.description ? [`  description: ${server.description}`] : []), `  target: ${server.target}${server.port ? `:${server.port}` : ""}`, `  shell: ${server.shellPreference}`, `  transport: ${server.transportPreference}`, `  mapped projects: ${dependencies.mappings.list().filter((item) => item.serverId === server.id).length}`);
      if (mapping) {
        const server = dependencies.servers.get(mapping.serverId);
        lines.push("", "Current project mirror:", `  server: ${server?.name ?? "missing"}`, `  remote cwd: ${mapping.remoteRoot}`, `  state: ${dependencies.getMirrorQueue(mapping)?.status.state ?? "unavailable"}`);
      }
      return { content: [{ type: "text", text: dependencies.servers.list().length ? lines.join("\n") : "No saved SSH servers. Use /ssh add." }], details: { count: dependencies.servers.list().length } };
    },
  });
  pi.registerTool({
    name: "ssh_exec", label: "SSH Exec",
    description: "Execute a command on a saved SSH server without changing Pi's local or full-remote workspace mode.",
    promptSnippet: "Run builds, tests, services, and diagnostics on a saved remote server",
    promptGuidelines: [
      "When a local project mirror is configured, use ssh_exec proactively for builds, tests, running code, and remote diagnostics; do not wait for the user to remind you.",
      "Continue reading and modifying code with local file tools; ssh_exec does not switch the workspace.",
      "Use require_synced=false only for diagnostics that do not depend on the latest code, never to test or start stale code.",
    ],
    parameters: Type.Object({ server: Type.Optional(Type.String()), command: Type.String({ minLength: 1 }), cwd: Type.Optional(Type.String()), timeout: Type.Optional(Type.Number({ minimum: 1, maximum: 86_400 })), require_synced: Type.Optional(Type.Boolean()) }),
    async execute(_id, params, signal, onUpdate, ctx) { return dependencies.controller.execute(params, ctx, signal, onUpdate); },
  });
  pi.registerTool({
    name: "ssh_sync", label: "SSH Sync",
    description: "Force strict synchronization and complete verification of the current trusted local project's remote mirror.",
    promptSnippet: "Force or recover synchronization of the current local project mirror",
    promptGuidelines: ["Use ssh_sync when automatic synchronization failed, is paused, or the user explicitly requests an immediate full verification; do not use ssh_sync in a full SSH workspace."],
    parameters: Type.Object({ force: Type.Optional(Type.Boolean()) }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (dependencies.isFullRemoteWorkspace()) throw new Error("ssh_sync is unavailable in a full SSH workspace because file tools already operate remotely");
      if (!ctx.isProjectTrusted()) throw new Error("The current project is not trusted; synchronization is disabled");
      const mapping = dependencies.mappings.find(ctx.cwd);
      if (!mapping) throw new Error("No remote mirror is configured for the current local project. Use /ssh map add.");
      const queue = dependencies.getMirrorQueue(mapping);
      if (!queue) throw new Error("The current project mirror is unavailable");
      await queue.requestSync({ reason: "tool", immediate: true, force: params.force });
      await queue.waitUntilSettled(signal);
      const audit = queue.auditRecords.at(-1);
      return { content: [{ type: "text", text: `Mirror synchronized\nServer mapping: ${mapping.serverId}\nRemote: ${mapping.remoteRoot}\nGeneration: ${queue.status.syncedGeneration}\nUploaded: ${audit?.uploaded.length ?? 0}\nDeleted: ${audit?.deleted.length ?? 0}\nVerified: ${audit?.verifiedFiles ?? 0}\nResult: exact match` }], details: { mappingId: mapping.id, state: queue.status.state, generation: queue.status.syncedGeneration } };
    },
  });
}
