import type { SyncAuditRecord, SyncReason, SyncResult } from "./types.ts";

export type MirrorQueueState = "initializing" | "watching" | "dirty" | "syncing" | "synced" | "failed" | "paused" | "closed";
export interface MirrorQueueStatus { state: MirrorQueueState; generation: number; syncedGeneration: number; lastError?: string; lastSuccessAt?: string; retryAttempt: number }
export interface SyncRequest { reason: SyncReason; immediate?: boolean; force?: boolean }

export interface MirrorQueueOptions {
  debounceMs: number;
  synchronize(generation: number, reason: SyncReason, signal: AbortSignal): Promise<SyncResult>;
  isRetryable?(error: unknown): boolean;
  onStatus?(status: MirrorQueueStatus): void;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  now?: () => Date;
  auditLimit?: number;
}

const RETRY_DELAYS = [2_000, 5_000, 15_000, 30_000] as const;

export class MirrorQueue {
  private generationValue = 0;
  private syncedGenerationValue = -1;
  private stateValue: MirrorQueueState = "initializing";
  private lastError?: string;
  private lastSuccessAt?: string;
  private retryAttempt = 0;
  private debounceTimer?: ReturnType<typeof setTimeout>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private requestedReason: SyncReason = "startup";
  private followUp = false;
  private paused = false;
  private closed = false;
  private abortController?: AbortController;
  private readonly waiters = new Set<() => void>();
  private readonly records: SyncAuditRecord[] = [];
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;

  constructor(private readonly options: MirrorQueueOptions) {
    if (!Number.isInteger(options.debounceMs) || options.debounceMs < 250 || options.debounceMs > 30_000) throw new Error("Mirror debounce must be from 250 to 30000 milliseconds");
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
    this.publish();
  }

  get status(): MirrorQueueStatus { return { state: this.stateValue, generation: this.generationValue, syncedGeneration: this.syncedGenerationValue, lastError: this.lastError, lastSuccessAt: this.lastSuccessAt, retryAttempt: this.retryAttempt }; }
  get auditRecords(): readonly SyncAuditRecord[] { return this.records.map((value) => ({ ...value, uploaded: [...value.uploaded], deleted: [...value.deleted], protected: [...value.protected] })); }
  private publish(): void { this.options.onStatus?.(this.status); }
  private setState(state: MirrorQueueState): void { this.stateValue = state; this.publish(); }
  private wake(): void { for (const resolve of [...this.waiters]) resolve(); this.waiters.clear(); }
  private clearTimers(): void { if (this.debounceTimer) this.clearTimeoutFn(this.debounceTimer); if (this.retryTimer) this.clearTimeoutFn(this.retryTimer); this.debounceTimer = undefined; this.retryTimer = undefined; }

  markDirty(reason: SyncReason = "file-change"): void {
    if (this.closed) return;
    this.generationValue += 1;
    this.requestedReason = reason;
    this.retryAttempt = 0;
    if (this.retryTimer) { this.clearTimeoutFn(this.retryTimer); this.retryTimer = undefined; }
    if (this.paused) { this.setState("paused"); return; }
    this.setState("dirty");
    if (this.running) { this.followUp = true; return; }
    if (this.debounceTimer) this.clearTimeoutFn(this.debounceTimer);
    this.debounceTimer = this.setTimeoutFn(() => { this.debounceTimer = undefined; void this.start(); }, this.options.debounceMs);
    this.debounceTimer.unref?.();
  }

  requestSync(request: SyncRequest): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Mirror queue is closed"));
    this.requestedReason = request.reason;
    if (request.force) this.generationValue += 1;
    if (this.paused) return Promise.reject(new Error("Project mirror is paused"));
    if (this.retryTimer) { this.clearTimeoutFn(this.retryTimer); this.retryTimer = undefined; }
    if (this.debounceTimer) { this.clearTimeoutFn(this.debounceTimer); this.debounceTimer = undefined; }
    if (this.running) this.followUp = true;
    else if (request.immediate !== false) void this.start();
    return this.waitUntilSettled();
  }

  private appendAudit(reason: SyncReason, generation: number, result: SyncAuditRecord["result"], sync?: SyncResult, error?: unknown): void {
    this.records.push({ timestamp: (this.options.now?.() ?? new Date()).toISOString(), reason, generation, uploaded: sync?.summary.uploadedFiles ?? [], deleted: [...(sync?.summary.deletedFiles ?? []), ...(sync?.summary.deletedDirectories ?? [])], protected: sync?.summary.protectedPaths ?? [], verifiedFiles: sync?.verifiedFiles ?? 0, result, error: error === undefined ? undefined : (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 500) });
    while (this.records.length > (this.options.auditLimit ?? 20)) this.records.shift();
  }

  private async start(): Promise<void> {
    if (this.closed || this.paused || this.running) return;
    const generation = this.generationValue, reason = this.requestedReason;
    this.setState("syncing");
    this.abortController = new AbortController();
    const work = (async () => {
      try {
        const result = await this.options.synchronize(generation, reason, this.abortController!.signal);
        if (result.result === "success" && generation === this.generationValue) {
          this.syncedGenerationValue = generation; this.lastError = undefined; this.lastSuccessAt = (this.options.now?.() ?? new Date()).toISOString(); this.retryAttempt = 0; this.setState("synced"); this.appendAudit(reason, generation, "success", result);
        } else { this.setState("dirty"); this.appendAudit(reason, generation, "stale", result); this.followUp = true; }
      } catch (error) {
        const cancelled = this.abortController?.signal.aborted;
        this.lastError = error instanceof Error ? error.message : String(error);
        this.setState(this.paused ? "paused" : "failed");
        this.appendAudit(reason, generation, cancelled ? "cancelled" : "failed", undefined, error);
        if (!cancelled && !this.paused && this.options.isRetryable?.(error) === true && this.retryAttempt < RETRY_DELAYS.length) {
          const delay = RETRY_DELAYS[this.retryAttempt++];
          this.retryTimer = this.setTimeoutFn(() => { this.retryTimer = undefined; void this.start(); }, delay);
          this.retryTimer.unref?.();
        }
      } finally {
        this.running = undefined; this.abortController = undefined; this.wake();
        if (this.followUp && !this.paused && !this.closed) {
          this.followUp = false;
          if (this.retryTimer) { this.clearTimeoutFn(this.retryTimer); this.retryTimer = undefined; }
          void this.start();
        }
      }
    })();
    this.running = work;
    await work;
  }

  async waitUntilSettled(signal?: AbortSignal): Promise<void> {
    while (!this.closed && (this.running || this.debounceTimer || this.followUp || this.stateValue === "dirty" || this.stateValue === "syncing")) {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Mirror wait aborted");
      await new Promise<void>((resolve, reject) => {
        const done = () => { signal?.removeEventListener("abort", aborted); resolve(); };
        const aborted = () => { this.waiters.delete(done); reject(signal?.reason instanceof Error ? signal.reason : new Error("Mirror wait aborted")); };
        this.waiters.add(done); signal?.addEventListener("abort", aborted, { once: true });
      });
    }
    if (this.stateValue === "failed") throw new Error(this.lastError ?? "Project mirror synchronization failed");
  }

  async pause(): Promise<void> { if (this.closed) return; this.paused = true; this.clearTimers(); this.abortController?.abort(new Error("Project mirror paused")); await this.running?.catch(() => {}); this.setState("paused"); this.wake(); }
  async resume(): Promise<void> { if (this.closed) throw new Error("Mirror queue is closed"); this.paused = false; this.retryAttempt = 0; this.generationValue += 1; this.setState("dirty"); await this.requestSync({ reason: "mapping-resumed", immediate: true }); }
  async shutdown(): Promise<void> { if (this.closed) return; this.closed = true; this.clearTimers(); this.abortController?.abort(new Error("Mirror queue closed")); await this.running?.catch(() => {}); this.setState("closed"); this.wake(); }
}
