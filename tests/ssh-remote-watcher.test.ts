import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { MirrorQueue } from "../extensions/ssh-remote/src/sync/queue.ts";
import { createProjectWatcher } from "../extensions/ssh-remote/src/sync/watcher.ts";

class FakeTimers {
  now = 0;
  items: Array<{ at: number; fn: () => void; active: boolean }> = [];
  setTimeout = ((fn: () => void, ms: number) => { const item = { at: this.now + ms, fn, active: true }; this.items.push(item); return { unref() {}, item } as any; }) as typeof setTimeout;
  clearTimeout = ((handle: any) => { if (handle?.item) handle.item.active = false; }) as typeof clearTimeout;
  advance(ms: number) { this.now += ms; for (const item of [...this.items].sort((a, b) => a.at - b.at)) if (item.active && item.at <= this.now) { item.active = false; item.fn(); } }
}

function result(generation: number): any { return { result: "success", generation, manifestMode: "git", summary: { createdDirectories: [], uploadedFiles: [], createdSymlinks: [], deletedFiles: [], deletedDirectories: [], protectedPaths: [], bytesUploaded: 0 }, verifiedFiles: 1, repaired: false }; }
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("debounce coalesces changes into one generation", async () => {
  const timers = new FakeTimers(), syncs: number[] = [];
  const queue = new MirrorQueue({ debounceMs: 1500, setTimeoutFn: timers.setTimeout, clearTimeoutFn: timers.clearTimeout, synchronize: async (generation) => { syncs.push(generation); return result(generation); } });
  queue.markDirty(); timers.advance(1000); queue.markDirty(); timers.advance(1499);
  assert.deepEqual(syncs, []);
  timers.advance(1); await tick(); await queue.waitUntilSettled();
  assert.deepEqual(syncs, [2]);
  await queue.shutdown();
});

test("changes during synchronization schedule one follow-up", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const syncs: number[] = [];
  const queue = new MirrorQueue({ debounceMs: 1500, synchronize: async (generation) => { syncs.push(generation); if (syncs.length === 1) await gate; return result(generation); } });
  const first = queue.requestSync({ reason: "startup", immediate: true });
  await tick(); queue.markDirty(); queue.markDirty(); release();
  await first; await queue.waitUntilSettled();
  assert.deepEqual(syncs, [0, 2]);
  await queue.shutdown();
});

test("retry delays are bounded and audit is bounded", async () => {
  const timers = new FakeTimers(); let calls = 0;
  const queue = new MirrorQueue({ debounceMs: 1500, auditLimit: 2, setTimeoutFn: timers.setTimeout, clearTimeoutFn: timers.clearTimeout, isRetryable: () => true, synchronize: async () => { calls++; throw new Error("connection refused"); } });
  void queue.requestSync({ reason: "startup", immediate: true }).catch(() => {}); await tick();
  for (const delay of [2000, 5000, 15000, 30000]) { timers.advance(delay); await tick(); }
  timers.advance(30000); await tick();
  assert.equal(calls, 5);
  assert.equal(queue.auditRecords.length, 2);
  assert.ok(queue.auditRecords.every((entry) => !JSON.stringify(entry).includes("file contents")));
  await queue.shutdown();
});

test("watcher falls back to polling after native error", async () => {
  const native = new EventEmitter() as any; native.close = () => {};
  let mode = "";
  const watcher = createProjectWatcher({ root: "/local/workspace", onChange: () => {}, onModeChange: (value) => { mode = value; }, watchFactory: (() => native) as any, pollFingerprint: async () => "one", setIntervalFn: (() => ({ unref() {} })) as any, clearIntervalFn: (() => {}) as any });
  native.emit("error", new Error("recursive unavailable"));
  assert.equal(mode, "polling");
  assert.equal(watcher.mode, "polling");
  watcher.close();
});
