import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import { posix } from "node:path";
import { MirrorExclusions } from "./exclusions.ts";
import { verifyAuthorizedMarker } from "./marker.ts";
import { RemoteMirrorFs } from "./remote-tree.ts";
import type {
  LocalMirrorManifest, RemoteMirrorEntry, SyncMutationSummary, SyncPlan, SyncResult, SyncSnapshot,
  VerificationMismatch, VerificationReport,
} from "./types.ts";

function depth(path: string): number { return path.split("/").length; }
function remoteMap(entries: readonly RemoteMirrorEntry[]): Map<string, RemoteMirrorEntry> { return new Map(entries.map((entry) => [entry.relativePath, entry])); }
function isProtectedOrAncestor(path: string, remoteEntries: readonly RemoteMirrorEntry[], exclusions: MirrorExclusions): boolean {
  return exclusions.isRemoteProtected(path) || remoteEntries.some((entry) => exclusions.isRemoteProtected(entry.relativePath) && entry.relativePath.startsWith(`${path}/`));
}

export function buildSyncPlan(local: LocalMirrorManifest, remote: readonly RemoteMirrorEntry[], exclusions: MirrorExclusions): SyncPlan {
  const byRemote = remoteMap(remote);
  const plan: SyncPlan = { createDirectories: [], uploadFiles: [], createSymlinks: [], replaceTypeConflicts: [], deleteFiles: [], deleteSymlinks: [], deleteDirectories: [], protectedPaths: [] };
  for (const [path, entry] of local.entries) {
    if (isProtectedOrAncestor(path, remote, exclusions)) { plan.protectedPaths.push(path); continue; }
    const existing = byRemote.get(path);
    if (existing && existing.type !== entry.type) plan.replaceTypeConflicts.push(path);
    if (entry.type === "directory" && (!existing || existing.type !== "directory")) plan.createDirectories.push(path);
    if (entry.type === "file" && (!existing || existing.type !== "file" || existing.size !== entry.size)) plan.uploadFiles.push(path);
    if (entry.type === "symlink" && (!existing || existing.type !== "symlink" || existing.target !== entry.target)) plan.createSymlinks.push(path);
  }
  for (const entry of remote) {
    if (local.entries.has(entry.relativePath)) continue;
    if (isProtectedOrAncestor(entry.relativePath, remote, exclusions)) { plan.protectedPaths.push(entry.relativePath); continue; }
    if (entry.type === "file") plan.deleteFiles.push(entry.relativePath);
    else if (entry.type === "symlink") plan.deleteSymlinks.push(entry.relativePath);
    else if (entry.type === "directory") plan.deleteDirectories.push(entry.relativePath);
    else throw new Error(`Unsupported remote mirror entry: ${entry.relativePath}`);
  }
  plan.createDirectories.sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
  plan.deleteDirectories.sort((a, b) => depth(b) - depth(a) || b.localeCompare(a));
  for (const key of Object.keys(plan) as Array<keyof SyncPlan>) plan[key] = [...new Set(plan[key])];
  return plan;
}

async function removeConflict(path: string, fs: RemoteMirrorFs, remote: Map<string, RemoteMirrorEntry>, signal?: AbortSignal): Promise<void> {
  const entry = remote.get(path);
  if (!entry) return;
  if (entry.type === "directory") {
    const descendants = [...remote.values()]
      .filter((candidate) => candidate.relativePath.startsWith(`${path}/`))
      .sort((left, right) => depth(right.relativePath) - depth(left.relativePath));
    for (const descendant of descendants) {
      if (descendant.type === "other") throw new Error(`Unsupported remote mirror entry: ${descendant.relativePath}`);
      await fs.remove(descendant.relativePath, descendant.type === "directory", signal);
      remote.delete(descendant.relativePath);
    }
  }
  await fs.remove(path, entry.type === "directory", signal);
  remote.delete(path);
}

export async function applySyncPlan(
  snapshot: SyncSnapshot,
  plan: SyncPlan,
  signal?: AbortSignal,
  onProgress: (message: string) => void = () => {},
): Promise<SyncMutationSummary> {
  const authorized = await verifyAuthorizedMarker(snapshot.mapping, snapshot.connection, signal);
  const exclusions = new MirrorExclusions(snapshot.mapping.localExcludePatterns, snapshot.mapping.remoteProtectedPatterns, snapshot.connection.workspace.platform === "windows");
  const remoteEntries = await authorized.fs.scan(exclusions, signal);
  const remote = remoteMap(remoteEntries);
  const summary: SyncMutationSummary = { createdDirectories: [], uploadedFiles: [], createdSymlinks: [], deletedFiles: [], deletedDirectories: [], protectedPaths: [...plan.protectedPaths], bytesUploaded: 0 };
  for (const path of plan.replaceTypeConflicts) await removeConflict(path, authorized.fs, remote, signal);
  for (const path of plan.createDirectories) {
    signal?.throwIfAborted(); onProgress(`Creating ${path}`);
    await snapshot.connection.adapter.mkdir(authorized.fs.tool(path), signal); summary.createdDirectories.push(path);
  }
  for (const path of plan.uploadFiles) {
    signal?.throwIfAborted(); onProgress(`Uploading ${path}`);
    const entry = snapshot.localManifest.entries.get(path);
    if (!entry || entry.type !== "file") throw new Error(`Local mirror file changed type: ${path}`);
    const stat = await lstat(entry.absolutePath);
    if (!stat.isFile() || stat.size !== entry.size) throw new Error(`Local mirror file changed during synchronization: ${path}`);
    const content = await readFile(entry.absolutePath);
    if (createHash("sha256").update(content).digest("hex") !== entry.sha256) throw new Error(`Local mirror file changed during synchronization: ${path}`);
    await authorized.fs.writeAtomic(path, content, entry.executable, signal);
    summary.uploadedFiles.push(path); summary.bytesUploaded += content.length;
  }
  for (const path of plan.createSymlinks) {
    const entry = snapshot.localManifest.entries.get(path);
    if (!entry || entry.type !== "symlink" || await readlink(posix.join(snapshot.localManifest.projectRoot, path)) !== entry.target) throw new Error(`Local symlink changed during synchronization: ${path}`);
    await authorized.fs.createSymlink(path, entry.target, signal); summary.createdSymlinks.push(path);
  }
  for (const path of [...plan.deleteFiles, ...plan.deleteSymlinks]) { await authorized.fs.remove(path, false, signal); summary.deletedFiles.push(path); }
  for (const path of plan.deleteDirectories) { await authorized.fs.remove(path, true, signal); summary.deletedDirectories.push(path); }
  return summary;
}

export async function verifyRemoteMirror(snapshot: SyncSnapshot, signal?: AbortSignal, onProgress: (message: string) => void = () => {}): Promise<VerificationReport> {
  const { fs } = await verifyAuthorizedMarker(snapshot.mapping, snapshot.connection, signal);
  const exclusions = new MirrorExclusions(snapshot.mapping.localExcludePatterns, snapshot.mapping.remoteProtectedPatterns, snapshot.connection.workspace.platform === "windows");
  const remoteEntries = await fs.scan(exclusions, signal);
  const remote = remoteMap(remoteEntries), mismatches: VerificationMismatch[] = [];
  let verifiedFiles = 0;
  for (const [path, local] of snapshot.localManifest.entries) {
    if (exclusions.isRemoteProtected(path)) continue;
    const item = remote.get(path);
    if (!item) { mismatches.push({ path, kind: "missing", message: "missing remote entry" }); continue; }
    if (item.type !== local.type) { mismatches.push({ path, kind: "type", message: `expected ${local.type}, found ${item.type}` }); continue; }
    if (local.type === "file") {
      onProgress(`Verifying ${path}`);
      try {
        const content = await snapshot.connection.adapter.readFile(fs.tool(path), signal);
        verifiedFiles++;
        if (createHash("sha256").update(content).digest("hex") !== local.sha256) mismatches.push({ path, kind: "content", message: "content hash mismatch" });
        if (snapshot.connection.workspace.platform === "unix" && item.type === "file" && item.executable !== local.executable) mismatches.push({ path, kind: "executable", message: "executable bit mismatch" });
      } catch (error) { mismatches.push({ path, kind: "read", message: error instanceof Error ? error.message : String(error) }); }
    } else if (local.type === "symlink" && item.type === "symlink" && item.target !== local.target) mismatches.push({ path, kind: "symlink", message: "symlink target mismatch" });
  }
  for (const item of remoteEntries) {
    if (!snapshot.localManifest.entries.has(item.relativePath) && !isProtectedOrAncestor(item.relativePath, remoteEntries, exclusions)) mismatches.push({ path: item.relativePath, kind: "unexpected", message: "unexpected remote entry" });
  }
  return { matches: mismatches.length === 0, verifiedFiles, mismatches: mismatches.slice(0, 100), remoteEntries };
}

function repairPlan(snapshot: SyncSnapshot, report: VerificationReport, exclusions: MirrorExclusions): SyncPlan {
  const plan = buildSyncPlan(snapshot.localManifest, report.remoteEntries, exclusions);
  for (const mismatch of report.mismatches) {
    const local = snapshot.localManifest.entries.get(mismatch.path);
    if (local?.type === "file" && !plan.uploadFiles.includes(mismatch.path)) plan.uploadFiles.push(mismatch.path);
    if (local?.type === "symlink" && !plan.createSymlinks.includes(mismatch.path)) plan.createSymlinks.push(mismatch.path);
  }
  return plan;
}

export async function synchronizeMirror(snapshot: SyncSnapshot, signal?: AbortSignal, onProgress: (message: string) => void = () => {}): Promise<SyncResult> {
  const authorized = await verifyAuthorizedMarker(snapshot.mapping, snapshot.connection, signal);
  const exclusions = new MirrorExclusions(snapshot.mapping.localExcludePatterns, snapshot.mapping.remoteProtectedPatterns, snapshot.connection.workspace.platform === "windows");
  const remote = await authorized.fs.scan(exclusions, signal);
  const initial = buildSyncPlan(snapshot.localManifest, remote, exclusions);
  const summary = await applySyncPlan(snapshot, initial, signal, onProgress);
  let verification = await verifyRemoteMirror(snapshot, signal, onProgress), repaired = false;
  if (!verification.matches) {
    repaired = true;
    const repair = repairPlan(snapshot, verification, exclusions);
    const repairedSummary = await applySyncPlan(snapshot, repair, signal, onProgress);
    for (const key of ["createdDirectories", "uploadedFiles", "createdSymlinks", "deletedFiles", "deletedDirectories", "protectedPaths"] as const) summary[key].push(...repairedSummary[key]);
    summary.bytesUploaded += repairedSummary.bytesUploaded;
    verification = await verifyRemoteMirror(snapshot, signal, onProgress);
  }
  if (!verification.matches) throw new Error(`Remote mirror verification failed:\n${verification.mismatches.map((value) => `- ${value.kind}: ${value.path}: ${value.message}`).join("\n")}`);
  return { result: snapshot.isGenerationCurrent() ? "success" : "stale", generation: snapshot.localGeneration, manifestMode: snapshot.localManifest.mode, summary, verifiedFiles: verification.verifiedFiles, repaired };
}
