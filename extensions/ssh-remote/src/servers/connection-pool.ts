import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { selectRemoteAdapter, type RemoteAdapter, type RemoteWorkspace } from "../adapters/index.ts";
import { createSshTransportClient, type SshPasswordProvider } from "../transport/index.ts";
import type { SshRemoteClient } from "../transport/client.ts";
import { SshPasswordResolver } from "../transport/password-resolver.ts";
import type { SavedSshServer } from "./types.ts";

export interface ServerConnectionLease {
  readonly client: SshRemoteClient;
  readonly adapter: RemoteAdapter;
  readonly workspace: RemoteWorkspace;
  release(): Promise<void>;
}

interface PoolEntry {
  key: string;
  client: SshRemoteClient;
  adapter: RemoteAdapter;
  workspace: RemoteWorkspace;
  references: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  retired: boolean;
  removeDisconnectListener?: () => void;
}

export interface ServerConnectionPoolOptions {
  platform?: NodeJS.Platform;
  idleTimeoutMs?: number;
  passwordResolver: SshPasswordResolver;
  passwordEnabled?: () => boolean;
  createClient?: typeof createSshTransportClient;
  selectRemote?: typeof selectRemoteAdapter;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export class ServerConnectionPool {
  private readonly platform: NodeJS.Platform;
  private readonly idleTimeoutMs: number;
  private readonly passwordResolver: SshPasswordResolver;
  private readonly passwordEnabled: () => boolean;
  private readonly createClient: typeof createSshTransportClient;
  private readonly selectRemote: typeof selectRemoteAdapter;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;
  private readonly entries = new Map<string, PoolEntry>();
  private readonly connecting = new Map<string, Promise<PoolEntry>>();
  private closed = false;

  constructor(options: ServerConnectionPoolOptions) {
    this.platform = options.platform ?? process.platform;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 600_000;
    this.passwordResolver = options.passwordResolver;
    this.passwordEnabled = options.passwordEnabled ?? (() => true);
    this.createClient = options.createClient ?? createSshTransportClient;
    this.selectRemote = options.selectRemote ?? selectRemoteAdapter;
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
  }

  private key(server: SavedSshServer): string { return `${server.id}\0${server.updatedAt}`; }

  private passwordProvider(ctx: ExtensionContext): SshPasswordProvider | undefined {
    if (!this.passwordEnabled()) { this.passwordResolver.setUI(undefined); return undefined; }
    this.passwordResolver.setUI(ctx.hasUI ? {
      prompt: (title, controls) => ctx.ui.input(title, "Enter the SSH password", controls ? {
        timeout: controls.timeoutMs,
        signal: controls.signal,
      } : undefined),
      notify: (message, type) => ctx.ui.notify(message, type),
    } : undefined);
    return {
      cached: (endpoint) => this.passwordResolver.cachedPassword(endpoint),
      retry: (endpoint, error) => this.passwordResolver.retryPassword(
        endpoint,
        error instanceof Error ? error.message : undefined,
      ),
    };
  }

  private async connect(server: SavedSshServer, ctx: ExtensionContext, signal?: AbortSignal): Promise<PoolEntry> {
    signal?.throwIfAborted();
    const key = this.key(server);
    const client = this.createClient({
      target: server.target,
      port: server.port,
      configFile: server.configFile,
      executable: this.platform === "win32" ? "ssh.exe" : undefined,
      connectTimeoutSeconds: 10,
      batchMode: true,
    }, {
      platform: this.platform,
      preference: server.transportPreference,
      passwordProvider: this.passwordProvider(ctx),
    });
    try {
      const selected = await this.selectRemote(client, {
        localPlatform: this.platform,
        preference: server.shellPreference,
      });
      signal?.throwIfAborted();
      const entry: PoolEntry = {
        key,
        client,
        adapter: selected.adapter,
        workspace: selected.workspace,
        references: 0,
        retired: false,
      };
      entry.removeDisconnectListener = client.onDisconnect?.(() => {
        entry.retired = true;
        if (entry.references === 0 && this.entries.get(key) === entry) void this.closeEntry(key, entry);
      });
      return entry;
    } catch (error) {
      await client.dispose();
      throw error;
    }
  }

  async acquire(server: SavedSshServer, ctx: ExtensionContext, signal?: AbortSignal): Promise<ServerConnectionLease> {
    if (this.closed) throw new Error("SSH server connection pool is closed");
    const key = this.key(server);
    for (const [entryKey, entry] of this.entries) {
      if (entryKey !== key && entryKey.startsWith(`${server.id}\0`)) {
        entry.retired = true;
        if (entry.references === 0) await this.closeEntry(entryKey, entry);
      }
    }
    let entry = this.entries.get(key);
    if (!entry) {
      let pending = this.connecting.get(key);
      if (!pending) {
        pending = this.connect({ ...server }, ctx, signal);
        this.connecting.set(key, pending);
      }
      try {
        const connected = await pending;
        const existing = this.entries.get(key);
        if (existing) entry = existing;
        else if (this.closed) {
          await connected.client.dispose();
          throw new Error("SSH server connection pool is closed");
        } else {
          entry = connected;
          this.entries.set(key, entry);
        }
      } finally {
        if (this.connecting.get(key) === pending) this.connecting.delete(key);
      }
    }
    if (signal?.aborted) {
      if (entry.references === 0) await this.closeEntry(key, entry);
      throw signal.reason instanceof Error ? signal.reason : new Error("SSH server connection cancelled");
    }
    if (entry.idleTimer) this.clearTimeoutFn(entry.idleTimer);
    entry.idleTimer = undefined;
    entry.references += 1;
    let released = false;
    return {
      client: entry.client,
      adapter: entry.adapter,
      workspace: entry.workspace,
      release: async () => {
        if (released) return;
        released = true;
        entry!.references = Math.max(0, entry!.references - 1);
        if (entry!.references !== 0) return;
        if (entry!.retired || this.closed) {
          await this.closeEntry(key, entry!);
          return;
        }
        entry!.idleTimer = this.setTimeoutFn(() => void this.closeEntry(key, entry!), this.idleTimeoutMs);
        entry!.idleTimer.unref?.();
      },
    };
  }

  private async closeEntry(key: string, entry: PoolEntry): Promise<void> {
    if (entry.idleTimer) this.clearTimeoutFn(entry.idleTimer);
    entry.idleTimer = undefined;
    entry.removeDisconnectListener?.();
    entry.removeDisconnectListener = undefined;
    if (this.entries.get(key) === entry) this.entries.delete(key);
    await entry.client.dispose();
  }

  async invalidate(serverId: string): Promise<void> {
    for (const [key, entry] of [...this.entries]) {
      if (!key.startsWith(`${serverId}\0`)) continue;
      entry.retired = true;
      if (entry.references === 0) await this.closeEntry(key, entry);
    }
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.allSettled([...this.connecting.values()]);
    await Promise.all([...this.entries].map(([key, entry]) => this.closeEntry(key, entry)));
    this.passwordResolver.setUI(undefined);
  }
}
