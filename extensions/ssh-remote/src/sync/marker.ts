import { posix, win32 } from "node:path";
import type { LocalProjectMapping } from "../mappings/types.ts";
import type { MirrorConnection, MirrorMarker } from "./types.ts";
import { RemoteMirrorFs } from "./remote-tree.ts";

export class MirrorAuthorizationError extends Error {
  constructor(readonly stage: string, message: string) {
    super(message);
    this.name = "MirrorAuthorizationError";
  }
}

const UNIX_DANGEROUS = new Set(["/", "/bin", "/boot", "/dev", "/etc", "/home", "/lib", "/lib64", "/opt", "/proc", "/root", "/run", "/sbin", "/srv", "/sys", "/tmp", "/usr", "/var"]);
const WINDOWS_DANGEROUS = new Set(["c:\\", "c:\\windows", "c:\\program files", "c:\\program files (x86)", "c:\\programdata", "c:\\users"]);

export async function validateMirrorRoot(
  connection: MirrorConnection,
  remoteRoot: string,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  let inspected;
  try { inspected = await connection.adapter.inspectWorkspace(remoteRoot); }
  catch (error) { throw new MirrorAuthorizationError("root", `Remote mirror root is not an accessible directory: ${remoteRoot}: ${error instanceof Error ? error.message : String(error)}`); }
  const root = inspected.cwd;
  if (inspected.platform === "unix") {
    const value = posix.normalize(root);
    if (UNIX_DANGEROUS.has(value) || value === posix.normalize(inspected.home)) throw new MirrorAuthorizationError("root", `Dangerous remote mirror root is forbidden: ${root}`);
    if (!value.startsWith("/")) throw new MirrorAuthorizationError("root", `Remote mirror root must be absolute: ${root}`);
  } else {
    const value = win32.normalize(root).toLowerCase();
    const home = win32.normalize(inspected.home).toLowerCase();
    const parsed = win32.parse(value);
    if (value === parsed.root.toLowerCase() || WINDOWS_DANGEROUS.has(value) || value === home || /^\\\\[^\\]+\\[^\\]+\\?$/.test(value)) {
      throw new MirrorAuthorizationError("root", `Dangerous Windows remote mirror root or profile is forbidden: ${root}`);
    }
  }
  return root;
}

function markerFor(mapping: LocalProjectMapping, canonicalRoot: string, createdAt = new Date().toISOString()): MirrorMarker {
  return { version: 1, markerId: mapping.markerId, mappingId: mapping.id, projectId: mapping.projectId, remoteRoot: canonicalRoot, createdAt };
}

export async function createAuthorizedMarker(
  mapping: LocalProjectMapping,
  userConfirmed: boolean,
  connection: MirrorConnection,
  signal?: AbortSignal,
): Promise<MirrorMarker> {
  if (!userConfirmed) throw new MirrorAuthorizationError("confirmation", "Remote mirror authorization was not confirmed");
  const canonicalRoot = await validateMirrorRoot(connection, mapping.remoteRoot, signal);
  const fs = new RemoteMirrorFs(connection.adapter, { ...connection.workspace, cwd: canonicalRoot }, canonicalRoot);
  if (await connection.adapter.fileExists(fs.tool(".pi-ssh-sync.json"), signal)) {
    const existing = await verifyAuthorizedMarker({ ...mapping, remoteRoot: canonicalRoot }, connection, signal);
    return existing.marker;
  }
  const marker = markerFor(mapping, canonicalRoot);
  await fs.writeAtomic(".pi-ssh-sync.json", Buffer.from(`${JSON.stringify(marker, null, 2)}\n`), false, signal);
  return marker;
}

export async function verifyAuthorizedMarker(
  mapping: LocalProjectMapping,
  connection: MirrorConnection,
  signal?: AbortSignal,
): Promise<{ marker: MirrorMarker; canonicalRoot: string; fs: RemoteMirrorFs }> {
  const canonicalRoot = await validateMirrorRoot(connection, mapping.remoteRoot, signal);
  const fs = new RemoteMirrorFs(connection.adapter, { ...connection.workspace, cwd: canonicalRoot }, canonicalRoot);
  let raw: Buffer;
  try {
    const stat = await connection.adapter.statPath(fs.tool(".pi-ssh-sync.json"), signal);
    if (stat.type !== "file") throw new Error("marker is not a regular file");
    if (stat.size > 64 * 1024) throw new Error("marker exceeds 64KB");
    raw = await connection.adapter.readFile(fs.tool(".pi-ssh-sync.json"), signal);
  } catch (error) {
    throw new MirrorAuthorizationError("marker", `Remote mirror marker is missing or unsafe: ${error instanceof Error ? error.message : String(error)}`);
  }
  let marker: MirrorMarker;
  try { marker = JSON.parse(raw.toString("utf8")) as MirrorMarker; }
  catch { throw new MirrorAuthorizationError("marker", "Remote mirror marker contains invalid JSON"); }
  if (marker.version !== 1 || marker.markerId !== mapping.markerId || marker.mappingId !== mapping.id || marker.projectId !== mapping.projectId) {
    throw new MirrorAuthorizationError("marker", "Remote mirror marker identity does not match the local project mapping");
  }
  const normalize = connection.workspace.platform === "windows"
    ? (value: string) => win32.normalize(value).toLowerCase()
    : (value: string) => posix.normalize(value);
  if (normalize(marker.remoteRoot) !== normalize(canonicalRoot)) throw new MirrorAuthorizationError("marker", "Remote mirror marker root does not match the authorized directory");
  return { marker, canonicalRoot, fs };
}
