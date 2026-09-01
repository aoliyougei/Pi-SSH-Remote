import { createHash } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MappingController } from "../mappings/controller.ts";
import type { LocalProjectMapping } from "../mappings/types.ts";
import type { ServerConnectionPool } from "../servers/connection-pool.ts";
import type { ServerController } from "../servers/controller.ts";
import { classifySshTransportFailure } from "../adapters/index.ts";
import { buildLocalManifest } from "./manifest.ts";
import { MirrorExclusions } from "./exclusions.ts";
import { MirrorQueue, type MirrorQueueStatus } from "./queue.ts";
import { synchronizeMirror } from "./synchronizer.ts";
import { createProjectWatcher, type ProjectWatcher } from "./watcher.ts";
import type { SyncReason, SyncSnapshot } from "./types.ts";

interface ActiveMirror { mapping: LocalProjectMapping; queue: MirrorQueue; watcher: ProjectWatcher; ctx: ExtensionContext }

export interface LocalMirrorControllerOptions {
  servers: ServerController;
  mappings: MappingController;
  connections: ServerConnectionPool;
  onStatus?(mapping: LocalProjectMapping, status: MirrorQueueStatus, watcherMode: string): void;
  onFailure?(message: string, ctx: ExtensionContext): void;
}

export class LocalMirrorController {
  private active?: ActiveMirror;
  private closed = false;
  constructor(private readonly options: LocalMirrorControllerOptions) {}
  get current(): ActiveMirror | undefined { return this.active; }
  getQueue(mapping: LocalProjectMapping): MirrorQueue | undefined { return this.active?.mapping.id === mapping.id ? this.active.queue : undefined; }

  private async fingerprint(mapping: LocalProjectMapping): Promise<string> {
    const manifest = await buildLocalManifest(mapping.localRootCanonical, { exclusions: new MirrorExclusions(mapping.localExcludePatterns, mapping.remoteProtectedPatterns) });
    return createHash("sha256").update([...manifest.entries.values()].map((entry) => `${entry.type}:${entry.relativePath}:${entry.type === "file" ? entry.sha256 : entry.type === "symlink" ? entry.target : ""}`).sort().join("\n")).digest("hex");
  }

  async activate(ctx: ExtensionContext, reason: SyncReason = "startup"): Promise<void> {
    if (this.closed) return;
    await this.deactivate();
    if (!ctx.isProjectTrusted()) { ctx.ui.setStatus("ssh-remote-mirror", ctx.ui.theme.fg("warning", "Mirror: Untrusted")); return; }
    const mapping = this.options.mappings.find(ctx.cwd);
    if (!mapping || mapping.paused || !mapping.autoSync) { ctx.ui.setStatus("ssh-remote-mirror", undefined); return; }
    const server = this.options.servers.get(mapping.serverId);
    if (!server) { ctx.ui.setStatus("ssh-remote-mirror", ctx.ui.theme.fg("error", "Mirror: Failed")); return; }
    let queue!: MirrorQueue;
    let watcherMode = "native";
    queue = new MirrorQueue({
      debounceMs: mapping.debounceMs,
      isRetryable: (error) => !!classifySshTransportFailure(error),
      onStatus: (status) => this.options.onStatus?.(mapping, status, watcherMode),
      synchronize: async (generation, syncReason, signal) => {
        const latestMapping = this.options.mappings.get(mapping.id);
        const latestServer = this.options.servers.get(server.id);
        if (!latestMapping || !latestServer) throw new Error("Saved SSH server or project mapping was removed");
        const manifest = await buildLocalManifest(latestMapping.localRootCanonical, { exclusions: new MirrorExclusions(latestMapping.localExcludePatterns, latestMapping.remoteProtectedPatterns, false) });
        const lease = await this.options.connections.acquire(latestServer, ctx, signal);
        try {
          const mappingGeneration = this.options.mappings.generation;
          const snapshot: SyncSnapshot = { mapping: latestMapping, server: latestServer, localManifest: manifest, connection: { adapter: lease.adapter, workspace: lease.workspace }, mappingGeneration, localGeneration: generation, isGenerationCurrent: () => queue.status.generation === generation && this.options.mappings.generation === mappingGeneration };
          return await synchronizeMirror(snapshot, signal);
        } finally { await lease.release(); }
      },
    });
    const watcher = createProjectWatcher({ root: mapping.localRootCanonical, onChange: () => queue.markDirty("file-change"), onModeChange: (mode) => { watcherMode = mode; this.options.onStatus?.(mapping, queue.status, watcherMode); }, pollFingerprint: () => this.fingerprint(mapping) });
    this.active = { mapping, queue, watcher, ctx };
    try { await queue.requestSync({ reason, immediate: true, force: true }); }
    catch (error) { this.options.onFailure?.(error instanceof Error ? error.message : String(error), ctx); }
  }

  async pause(): Promise<void> { if (!this.active) return; this.active.watcher.close(); await this.active.queue.pause(); }
  async resume(ctx: ExtensionContext): Promise<void> { await this.activate(ctx, "ssh-exit"); }
  async deactivate(): Promise<void> { const active = this.active; this.active = undefined; if (!active) return; active.watcher.close(); await active.queue.shutdown(); active.ctx.ui.setStatus("ssh-remote-mirror", undefined); }
  async shutdown(): Promise<void> { if (this.closed) return; this.closed = true; await this.deactivate(); }
}
