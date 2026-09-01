import { watch, type FSWatcher } from "node:fs";

export type WatcherMode = "native" | "polling";
export interface ProjectWatcher {
  readonly mode: WatcherMode;
  close(): void;
}

export interface ProjectWatcherOptions {
  root: string;
  onChange(): void;
  onModeChange?(mode: WatcherMode): void;
  pollFingerprint?(): Promise<string>;
  pollIntervalMs?: number;
  watchFactory?: typeof watch;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

export function createProjectWatcher(options: ProjectWatcherOptions): ProjectWatcher {
  const watchFactory = options.watchFactory ?? watch;
  const setIntervalFn = options.setIntervalFn ?? setInterval;
  const clearIntervalFn = options.clearIntervalFn ?? clearInterval;
  let native: FSWatcher | undefined;
  let poller: ReturnType<typeof setInterval> | undefined;
  let mode: WatcherMode = "native";
  let closed = false;
  let fingerprint: string | undefined;
  let polling = false;

  const startPolling = (): void => {
    if (closed || poller) return;
    mode = "polling";
    options.onModeChange?.(mode);
    const tick = async () => {
      if (closed || polling || !options.pollFingerprint) return;
      polling = true;
      try {
        const next = await options.pollFingerprint();
        if (fingerprint !== undefined && next !== fingerprint) options.onChange();
        fingerprint = next;
      } finally { polling = false; }
    };
    void tick();
    poller = setIntervalFn(() => void tick(), options.pollIntervalMs ?? 2_000);
    poller.unref?.();
  };

  try {
    native = watchFactory(options.root, { recursive: true }, () => options.onChange());
    native.once("error", () => {
      try { native?.close(); } catch {}
      native = undefined;
      startPolling();
    });
  } catch {
    startPolling();
  }

  return {
    get mode() { return mode; },
    close() {
      if (closed) return;
      closed = true;
      try { native?.close(); } catch {}
      native = undefined;
      if (poller) clearIntervalFn(poller);
      poller = undefined;
    },
  };
}
