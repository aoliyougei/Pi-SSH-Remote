import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { lstat, readdir, readFile, readlink, realpath } from "node:fs/promises";
import { dirname, posix, relative, resolve, sep } from "node:path";
import type { LocalManifestEntry, LocalMirrorManifest, SyncLimits } from "./types.ts";
import { DEFAULT_SYNC_LIMITS } from "./types.ts";
import { containsPrivateKeyMaterial, MirrorExclusions } from "./exclusions.ts";

export interface LocalCommandResult { stdout: Buffer; stderr: Buffer; exitCode: number | null }
export type LocalGitRunner = (args: readonly string[], cwd: string) => Promise<LocalCommandResult>;

export interface BuildLocalManifestOptions {
  exclusions: MirrorExclusions;
  limits?: Partial<SyncLimits>;
  git?: LocalGitRunner;
  now?: () => Date;
}

function pathDepth(path: string): number { return path.split("/").filter(Boolean).length; }
function toRelative(root: string, absolute: string): string { return relative(root, absolute).split(sep).join("/"); }

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function parseNul(buffer: Buffer): string[] {
  const values = buffer.toString("utf8").split("\0");
  if (values.at(-1) === "") values.pop();
  return values;
}

function scopedIgnorePatterns(base: string, source: string): string[] {
  const output: string[] = [];
  for (const rawLine of source.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const negated = trimmed.startsWith("!");
    let pattern = negated ? trimmed.slice(1) : trimmed;
    if (!pattern) continue;
    pattern = pattern.replace(/\\ /g, " ").replace(/^\//, "").replace(/\/$/, "/**");
    const prefix = negated ? "!" : "";
    if (pattern.includes("/")) output.push(`${prefix}${base ? `${base}/` : ""}${pattern}`);
    else {
      output.push(`${prefix}${base ? `${base}/` : ""}${pattern}`);
      output.push(`${prefix}${base ? `${base}/` : ""}**/${pattern}`);
    }
  }
  return output;
}

async function defaultGit(args: readonly string[], cwd: string): Promise<LocalCommandResult> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    child.stdout.on("data", (data: Buffer) => stdout.push(data));
    child.stderr.on("data", (data: Buffer) => stderr.push(data));
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode }));
  });
}

async function gitPaths(root: string, run: LocalGitRunner): Promise<{ paths: string[]; executable: Set<string> } | undefined> {
  try {
    const top = await run(["rev-parse", "--show-toplevel"], root);
    if (top.exitCode !== 0) return undefined;
    const gitRoot = (await realpath(top.stdout.toString("utf8").trim())).replace(/[\\/]$/, "");
    const listed = await run(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], gitRoot);
    if (listed.exitCode !== 0) return undefined;
    const staged = await run(["ls-files", "-s", "-z"], gitRoot);
    const executable = new Set<string>();
    if (staged.exitCode === 0) {
      for (const entry of parseNul(staged.stdout)) {
        const match = /^(\d+)\s+[0-9a-f]+\s+\d+\t(.+)$/.exec(entry);
        if (match?.[1] === "100755") executable.add(match[2]);
      }
    }
    const rootFromGit = toRelative(gitRoot, root);
    if (rootFromGit.startsWith("../") || rootFromGit === "..") return undefined;
    const prefix = rootFromGit ? `${rootFromGit}/` : "";
    return {
      paths: parseNul(listed.stdout).filter((path) => !prefix || path.startsWith(prefix)).map((path) => prefix ? path.slice(prefix.length) : path),
      executable: new Set([...executable].filter((path) => !prefix || path.startsWith(prefix)).map((path) => prefix ? path.slice(prefix.length) : path)),
    };
  } catch { return undefined; }
}

function assertInternalSymlink(root: string, path: string, target: string): void {
  if (!target || posix.isAbsolute(target) || /^[A-Za-z]:[\\/]/.test(target)) throw new Error(`Unsafe absolute symlink: ${path}`);
  const resolved = resolve(dirname(resolve(root, path)), target);
  const fromRoot = relative(root, resolved);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) throw new Error(`Symlink escapes project root: ${path}`);
}

function assertNoSymlinkCycles(root: string, entries: ReadonlyMap<string, LocalManifestEntry>): void {
  const links = new Map<string, string>();
  for (const [path, entry] of entries) {
    if (entry.type !== "symlink") continue;
    const resolved = toRelative(root, resolve(dirname(resolve(root, path)), entry.target));
    links.set(path, resolved);
  }
  for (const start of links.keys()) {
    const visited = new Set<string>();
    let current: string | undefined = start;
    while (current !== undefined && links.has(current)) {
      if (visited.has(current)) throw new Error(`Symlink cycle detected: ${start}`);
      visited.add(current);
      current = links.get(current);
    }
  }
}

export async function buildLocalManifest(rootInput: string, options: BuildLocalManifestOptions): Promise<LocalMirrorManifest> {
  const root = await realpath(resolve(rootInput));
  const limits = { ...DEFAULT_SYNC_LIMITS, ...options.limits };
  const entries = new Map<string, LocalManifestEntry>();
  let totalBytes = 0, fileCount = 0, symlinkCount = 0;
  const addPath = async (relativePath: string, executable = false): Promise<void> => {
    const path = options.exclusions.assertSafeRelative(relativePath);
    if (options.exclusions.isLocalExcluded(path)) return;
    if (pathDepth(path) > limits.maxDepth) throw new Error(`Mirror depth limit exceeded: ${path}`);
    const absolute = resolve(root, ...path.split("/"));
    const fromRoot = relative(root, absolute);
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) throw new Error(`Mirror path escapes project root: ${path}`);
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) {
      symlinkCount++;
      if (symlinkCount > limits.maxSymlinks) throw new Error("Mirror symlink limit exceeded");
      const target = await readlink(absolute);
      assertInternalSymlink(root, path, target);
      entries.set(path, { type: "symlink", relativePath: path, target });
      return;
    }
    if (!stat.isFile()) throw new Error(`Unsupported local mirror entry: ${path}`);
    fileCount++;
    if (fileCount > limits.maxFiles) throw new Error("Mirror file count limit exceeded");
    if (stat.size > limits.maxFileBytes) throw new Error(`Mirror file size limit exceeded: ${path}`);
    totalBytes += stat.size;
    if (totalBytes > limits.maxTotalBytes) throw new Error("Mirror total size limit exceeded");
    if (containsPrivateKeyMaterial(await readFile(absolute))) throw new Error(`Private key material cannot be synchronized: ${path}`);
    entries.set(path, { type: "file", relativePath: path, absolutePath: absolute, size: stat.size, sha256: await hashFile(absolute), executable });
    let parent = posix.dirname(path);
    while (parent !== "." && parent) {
      if (!entries.has(parent)) entries.set(parent, { type: "directory", relativePath: parent });
      parent = posix.dirname(parent);
    }
  };

  const git = await gitPaths(root, options.git ?? defaultGit);
  if (git) {
    for (const path of [...new Set(git.paths)].sort()) {
      if (!existsSync(resolve(root, ...path.split("/")))) continue;
      await addPath(path, git.executable.has(path));
    }
  } else {
    const queue: Array<{ directory: string; exclusions: MirrorExclusions }> = [{ directory: "", exclusions: options.exclusions }];
    while (queue.length) {
      const { directory, exclusions } = queue.shift()!;
      const absoluteDirectory = resolve(root, ...directory.split("/").filter(Boolean));
      let scoped = exclusions;
      try {
        const ignoreSource = await readFile(resolve(absoluteDirectory, ".gitignore"), "utf8");
        scoped = exclusions.withLocalPatterns(scopedIgnorePatterns(directory, ignoreSource));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      for (const item of await readdir(absoluteDirectory, { withFileTypes: true })) {
        const path = directory ? `${directory}/${item.name}` : item.name;
        const ignored = scoped.isLocalExcluded(path);
        if (item.isDirectory()) {
          if (!ignored || scoped.mayReincludeDescendant(path)) queue.push({ directory: path, exclusions: scoped });
          continue;
        }
        if (ignored) continue;
        await addPath(path, false);
      }
    }
  }
  assertNoSymlinkCycles(root, entries);
  return { version: 1, mode: git ? "git" : "filesystem", projectRoot: root, generatedAt: (options.now?.() ?? new Date()).toISOString(), entries, totalBytes };
}
