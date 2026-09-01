import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SshShellPreference } from "../adapters/types.ts";
import type { MappingController } from "../mappings/controller.ts";
import { DEFAULT_REMOTE_PROTECTED_PATTERNS, type LocalProjectMapping } from "../mappings/types.ts";
import type { SshTransportPreference } from "../transport/client.ts";
import { expandLocalPath, parseSshTarget } from "../workspace/target.ts";
import type { ServerConnectionPool } from "./connection-pool.ts";
import type { ServerController } from "./controller.ts";
import type { SavedSshServer } from "./types.ts";

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
}

function displayTarget(server: SavedSshServer): string {
  return `${server.target}${server.port === undefined ? "" : `:${server.port}`}`;
}

function parsePort(value: string | undefined): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (!/^\d+$/.test(text)) throw new Error("SSH port must be an integer from 1 to 65535");
  const port = Number(text);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("SSH port must be an integer from 1 to 65535");
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
  const selected = await ctx.ui.select("Select SSH server", labels);
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
      `Server: ${server.name}`,
      `Target: ${displayTarget(server)}`,
      "Status: reachable",
      `Platform: ${lease.workspace.platform}`,
      `Shell: ${lease.workspace.shell}`,
      `Transport: ${lease.client.transport ?? "custom"}${lease.client.reusesConnection === undefined ? "" : lease.client.reusesConnection ? " (reused)" : " (single-use)"}`,
      `Home: ${lease.workspace.home}`,
      `Login cwd: ${lease.workspace.cwd}`,
    ].join("\n");
  } finally {
    await lease.release();
  }
}

async function addServer(
  ctx: ExtensionContext,
  dependencies: SshManagementCommandDependencies,
): Promise<void> {
  if (!ctx.hasUI) throw new Error("/ssh add requires an interactive UI");
  const name = (await ctx.ui.input("Server name", "test-api"))?.trim();
  if (!name) return;
  const description = (await ctx.ui.input("Description (optional)", ""))?.trim() || undefined;
  const rawTarget = (await ctx.ui.input("SSH target or OpenSSH alias", "deploy@devbox"))?.trim();
  if (!rawTarget) return;
  const parsed = parseSshTarget(rawTarget);
  if (parsed.requestedCwd) throw new Error("Saved server targets cannot include a remote project path; configure it with /ssh map add");
  const enteredPort = await ctx.ui.input("Explicit port (optional)", parsed.port === undefined ? "" : String(parsed.port));
  const port = parsePort(enteredPort) ?? parsed.port;
  const configInput = (await ctx.ui.input("Local OpenSSH config path (optional)", ""))?.trim() || undefined;
  const configFile = configInput ? expandLocalPath(configInput, ctx.cwd) : undefined;
  const shell = await ctx.ui.select("Remote shell", ["auto", "bash", "zsh", "pwsh", "powershell"]);
  if (!shell) return;
  const transport = await ctx.ui.select("SSH transport", ["auto", "openssh", "ssh2"]);
  if (!transport) return;
  const timestamp = new Date().toISOString();
  const server: SavedSshServer = {
    version: 1,
    id: randomUUID(),
    name,
    description,
    target: parsed.target,
    port,
    configFile,
    shellPreference: shell as SshShellPreference,
    transportPreference: transport as SshTransportPreference,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  ctx.ui.notify(`Testing ${server.name}...`, "info");
  const status = await testServer(server, ctx, dependencies.connections);
  dependencies.servers.add(server);
  dependencies.onServersChanged?.();
  ctx.ui.notify(`${status}\n\nSaved SSH server: ${server.name}`, "info");
}

async function editServer(
  requested: string | undefined,
  ctx: ExtensionContext,
  dependencies: SshManagementCommandDependencies,
): Promise<void> {
  if (!ctx.hasUI) throw new Error("/ssh edit requires an interactive UI");
  const original = await selectServer(ctx, dependencies.servers.list(), requested);
  if (!original) throw new Error(requested ? `SSH server not found: ${requested}` : "No SSH server selected");
  const name = (await ctx.ui.input(`Server name (current: ${original.name})`, original.name))?.trim() || original.name;
  const descriptionInput = await ctx.ui.input(`Description (current: ${original.description ?? "none"}; '-' clears)`, original.description ?? "");
  const description = descriptionInput?.trim() === "-" ? undefined : descriptionInput?.trim() || original.description;
  const targetInput = (await ctx.ui.input(`SSH target (current: ${original.target})`, original.target))?.trim() || original.target;
  const parsed = parseSshTarget(targetInput);
  if (parsed.requestedCwd) throw new Error("Saved server targets cannot include a remote project path");
  const port = parsePort(await ctx.ui.input(`Port (current: ${original.port ?? "configured/default"})`, original.port === undefined ? "" : String(original.port))) ?? parsed.port;
  const configInput = (await ctx.ui.input(`Local OpenSSH config (current: ${original.configFile ?? "default"}; '-' clears)`, original.configFile ?? ""))?.trim();
  const configFile = configInput === "-" ? undefined : configInput ? expandLocalPath(configInput, ctx.cwd) : original.configFile;
  const shell = await ctx.ui.select("Remote shell", ["auto", "bash", "zsh", "pwsh", "powershell"]);
  if (!shell) return;
  const transport = await ctx.ui.select("SSH transport", ["auto", "openssh", "ssh2"]);
  if (!transport) return;
  const candidate: SavedSshServer = {
    ...original,
    name,
    description,
    target: parsed.target,
    port,
    configFile,
    shellPreference: shell as SshShellPreference,
    transportPreference: transport as SshTransportPreference,
    updatedAt: new Date().toISOString(),
  };
  const status = await testServer(candidate, ctx, dependencies.connections);
  dependencies.servers.update(original.id, candidate);
  await dependencies.connections.invalidate(original.id);
  dependencies.onServersChanged?.();
  ctx.ui.notify(`${status}\n\nUpdated SSH server: ${candidate.name}`, "info");
}

async function removeServer(
  requested: string | undefined,
  ctx: ExtensionContext,
  dependencies: SshManagementCommandDependencies,
): Promise<void> {
  const server = await selectServer(ctx, dependencies.servers.list(), requested);
  if (!server) throw new Error(requested ? `SSH server not found: ${requested}` : "No SSH server selected");
  const mappings = dependencies.mappings.list().filter((mapping) => mapping.serverId === server.id);
  if (!ctx.hasUI) throw new Error("/ssh rm requires an interactive confirmation");
  const message = mappings.length > 0
    ? `${server.name} is referenced by ${mappings.length} project mapping(s). Delete the server and those local mappings? Remote files and markers are not deleted.`
    : `Delete saved SSH server ${server.name}? Remote files and SSH credentials are not deleted.`;
  if (!await ctx.ui.confirm("Delete SSH server", message)) return;
  for (const mapping of mappings) dependencies.mappings.remove(mapping.id);
  dependencies.servers.remove(server.id);
  await dependencies.connections.invalidate(server.id);
  dependencies.onServersChanged?.();
  ctx.ui.notify(`Deleted SSH server: ${server.name}`, "info");
}

function listServers(dependencies: SshManagementCommandDependencies): string {
  const servers = dependencies.servers.list();
  if (servers.length === 0) return "No saved SSH servers. Use /ssh add.";
  return ["SSH servers:", ...servers.flatMap((server) => {
    const mappings = dependencies.mappings.list().filter((mapping) => mapping.serverId === server.id).length;
    return [
      "",
      server.name,
      ...(server.description ? [`  description: ${server.description}`] : []),
      `  target: ${displayTarget(server)}`,
      `  shell: ${server.shellPreference}`,
      `  transport: ${server.transportPreference}`,
      `  mapped projects: ${mappings}`,
    ];
  })].join("\n");
}

export function registerSshManagementCommands(
  pi: ExtensionAPI,
  dependencies: SshManagementCommandDependencies,
): void {
  pi.registerCommand("ssh", {
    description: "Manage saved SSH servers and local project mirrors",
    handler: async (rawArgs, ctx) => {
      const [command = "", ...rest] = rawArgs.trim().split(/\s+/).filter(Boolean);
      const argument = rest.join(" ") || undefined;
      try {
        if (["add", "new", "edit", "rm", "remove", "delete"].includes(command.toLowerCase())) {
          await ctx.waitForIdle();
        }
        if (!command) {
          if (!ctx.hasUI) throw new Error("Use /ssh add|edit|rm|ls|test in non-interactive mode");
          const selected = await ctx.ui.select("SSH management", ["List servers", "Add server", "Edit server", "Remove server", "Test server"]);
          const routed = selected === "List servers" ? "ls" : selected === "Add server" ? "add" : selected === "Edit server" ? "edit" : selected === "Remove server" ? "rm" : selected === "Test server" ? "test" : undefined;
          if (!routed) return;
          await route(routed, undefined, ctx, dependencies);
          return;
        }
        await route(command.toLowerCase(), argument, ctx, dependencies);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
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
    if (!server) throw new Error(argument ? `SSH server not found: ${argument}` : "No SSH server selected");
    ctx.ui.notify(await testServer(server, ctx, dependencies.connections), "info");
    return;
  }
  if (command === "map") {
    if (dependencies.isFullRemoteWorkspace()) throw new Error("Project mappings can only be managed from a local workspace; use /ssh-exit first");
    const [action = "show"] = (argument ?? "show").split(/\s+/);
    const existing = dependencies.mappings.find(ctx.cwd);
    if (action === "show") {
      if (!existing) { ctx.ui.notify("No remote mirror is configured for the current local project. Use /ssh map add.", "info"); return; }
      const server = dependencies.servers.get(existing.serverId);
      ctx.ui.notify(`Project mirror\nLocal root: ${existing.localRoot}\nServer: ${server?.name ?? "missing"}\nRemote root: ${existing.remoteRoot}\nAuto sync: ${existing.autoSync ? "enabled" : "disabled"}\nPaused: ${existing.paused ? "yes" : "no"}`, "info");
      return;
    }
    await ctx.waitForIdle();
    if (action === "add") {
      if (existing) throw new Error("The current local project already has a mapping; remove or edit it first");
      if (!ctx.hasUI) throw new Error("/ssh map add requires an interactive UI");
      const server = await selectServer(ctx, dependencies.servers.list());
      if (!server) throw new Error("No SSH server selected; use /ssh add first");
      const remoteRoot = (await ctx.ui.input("Remote mirror directory", "/srv/test/project"))?.trim();
      if (!remoteRoot) return;
      const timestamp = new Date().toISOString();
      const mapping: LocalProjectMapping = { version: 1, id: randomUUID(), projectId: randomUUID(), localRoot: ctx.cwd, localRootCanonical: ctx.cwd, matchSubdirectories: true, serverId: server.id, remoteRoot, autoSync: true, debounceMs: 1500, localExcludePatterns: [], remoteProtectedPatterns: [...DEFAULT_REMOTE_PROTECTED_PATTERNS], markerId: randomUUID(), paused: false, createdAt: timestamp, updatedAt: timestamp };
      if (!dependencies.authorizeMapping) throw new Error("Project mirror subsystem is unavailable");
      await dependencies.authorizeMapping(mapping, ctx);
      return;
    }
    if (!existing) throw new Error("No remote mirror is configured for the current local project");
    if (action === "edit") {
      if (!ctx.hasUI) throw new Error("/ssh map edit requires an interactive UI");
      const server = await selectServer(ctx, dependencies.servers.list());
      if (!server) throw new Error("Mapped SSH server is unavailable");
      const remoteRoot = (await ctx.ui.input(`Remote mirror directory (current: ${existing.remoteRoot})`, existing.remoteRoot))?.trim() || existing.remoteRoot;
      const localExcludeText = await ctx.ui.input("Additional local exclusions (comma-separated)", existing.localExcludePatterns.join(","));
      const protectedText = await ctx.ui.input("Remote protected paths (comma-separated)", existing.remoteProtectedPatterns.join(","));
      const debounceText = await ctx.ui.input("Debounce milliseconds (250-30000)", String(existing.debounceMs));
      const debounceMs = Number(debounceText ?? existing.debounceMs);
      if (!Number.isInteger(debounceMs) || debounceMs < 250 || debounceMs > 30_000) throw new Error("Mirror debounce must be from 250 to 30000 milliseconds");
      const split = (value: string | undefined) => (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
      const candidate: LocalProjectMapping = { ...existing, serverId: server.id, remoteRoot, localExcludePatterns: split(localExcludeText), remoteProtectedPatterns: split(protectedText), debounceMs, updatedAt: new Date().toISOString(), ...(server.id !== existing.serverId || remoteRoot !== existing.remoteRoot ? { markerId: randomUUID() } : {}) };
      await dependencies.replaceMapping?.(existing, candidate, ctx);
      return;
    }
    if (action === "rm" || action === "remove") { await dependencies.removeMapping?.(existing, ctx); return; }
    if (action === "pause") { await dependencies.pauseMapping?.(existing, ctx); return; }
    if (action === "resume") { await dependencies.resumeMapping?.(existing, ctx); return; }
    throw new Error("Usage: /ssh map [add|show|edit|rm|pause|resume]");
  }
  if (command === "sync") { await ctx.waitForIdle(); await dependencies.syncMapping?.(ctx); return; }
  if (command === "config") {
    ctx.ui.notify("Use /aoliyougei-settings and open SSH Remote.", "info");
    return;
  }
  throw new Error("Usage: /ssh [add|edit|rm|ls|test|config|map|sync]");
}
