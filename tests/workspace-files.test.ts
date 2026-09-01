import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  collectWorkspaceFile,
  createLocalWorkspaceFiles,
  registerWorkspaceFileProvider,
  resolveWorkspaceFiles,
  type WorkspaceFileSystem,
} from "@aoliyougei/pi-workspace-files";

function eventApi(): Pick<ExtensionAPI, "events"> {
  const bus = new EventEmitter();
  return {
    events: {
      on: (name, handler) => {
        bus.on(name, handler);
        return () => bus.off(name, handler);
      },
      emit: (name, data) => {
        bus.emit(name, data);
      },
    },
  };
}

test("local workspace files resolve, read, and write binary data inside the root", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workspace-files-"));
  try {
    const files = createLocalWorkspaceFiles(root);
    const output = files.resolvePath("assets/image.png");
    const bytes = Buffer.from([0, 1, 2, 255]);
    assert.equal(files.extname(output), ".png");
    assert.equal(await files.exists(output), false);
    await files.mkdir(files.dirname(output));
    await files.writeFile(output, bytes);
    assert.equal(await files.exists(output), true);
    assert.deepEqual(
      await collectWorkspaceFile(await files.readFile(output)),
      bytes,
    );
    assert.deepEqual(await readFile(output), bytes);

    const streamed = files.resolvePath("assets/streamed.bin");
    async function* chunks() {
      yield Uint8Array.from([1, 2]);
      yield Uint8Array.from([3, 4]);
    }
    await files.writeFile(streamed, chunks());
    assert.deepEqual(await readFile(streamed), Buffer.from([1, 2, 3, 4]));
    assert.throws(
      () => files.resolvePath("../outside.png"),
      /must stay inside the current workspace/,
    );

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => files.readFile(output, { signal: controller.signal }),
      /aborted/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace providers are composable, optional, and uniquely claimed", () => {
  const pi = eventApi();
  const localRoot = process.cwd();
  const remoteFiles = {
    resolvePath: (path: string) => `/remote/${path}`,
    extname: () => ".bin",
    dirname: () => "/remote",
    exists: async () => false,
    readFile: async () => Buffer.from("remote"),
    mkdir: async () => {},
    writeFile: async () => {},
  } satisfies WorkspaceFileSystem;

  const unsubscribe = registerWorkspaceFileProvider(
    pi,
    "test-remote",
    ({ cwd }) => cwd === "/local-anchor" ? remoteFiles : undefined,
  );
  assert.equal(resolveWorkspaceFiles(pi, "/local-anchor"), remoteFiles);
  assert.notEqual(resolveWorkspaceFiles(pi, localRoot), remoteFiles);

  registerWorkspaceFileProvider(pi, "second-remote", () => remoteFiles);
  assert.throws(
    () => resolveWorkspaceFiles(pi, "/local-anchor"),
    /Multiple extensions claimed.*test-remote, second-remote/,
  );
  unsubscribe();
  assert.equal(resolveWorkspaceFiles(pi, "/local-anchor"), remoteFiles);
  assert.throws(
    () => registerWorkspaceFileProvider(pi, "\n", () => remoteFiles),
    /owner must be a non-empty single line/,
  );
});

import {
  registerWorkspaceFileProviderV2,
  resolveWorkspaceFilesV2,
  type WorkspaceFileSystemV2,
} from "@aoliyougei/pi-workspace-files";

test("workspace files v2 lists and lstats local entries without following symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workspace-files-v2-"));
  try {
    await writeFile(join(root, "a.txt"), "a");
    await mkdir(join(root, "dir"));
    const { symlink } = await import("node:fs/promises");
    await symlink(join(root, "a.txt"), join(root, "link"));
    const files = createLocalWorkspaceFiles(root) as WorkspaceFileSystemV2;
    assert.deepEqual(await files.stat(files.resolvePath("a.txt")), { type: "file", size: 1 });
    assert.equal((await files.stat(files.resolvePath("link"))).type, "symlink");
    const entries = await files.listDirectory(files.resolvePath("."));
    assert.deepEqual(entries.map((entry) => [entry.name, entry.type]), [["a.txt", "file"], ["dir", "directory"], ["link", "symlink"]]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("workspace v2 providers claim independently while v1 remains compatible", () => {
  const pi = eventApi();
  const remote = { ...createLocalWorkspaceFiles(process.cwd()), stat: async () => ({ type: "directory" as const, size: 0 }), listDirectory: async () => [] };
  registerWorkspaceFileProviderV2(pi, "remote-v2", () => remote);
  assert.equal(resolveWorkspaceFilesV2(pi, "/anchor"), remote);
  assert.notEqual(resolveWorkspaceFiles(pi, "/anchor"), remote);
});

test("workspace v2 rejects duplicate claims", () => {
  const pi = eventApi();
  const remote = createLocalWorkspaceFiles(process.cwd());
  registerWorkspaceFileProviderV2(pi, "one", () => remote);
  registerWorkspaceFileProviderV2(pi, "two", () => remote);
  assert.throws(() => resolveWorkspaceFilesV2(pi, "/anchor"), /Multiple extensions/);
});
