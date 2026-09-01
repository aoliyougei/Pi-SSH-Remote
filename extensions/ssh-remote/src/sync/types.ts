import type { RemoteAdapter, RemoteWorkspace } from "../adapters/types.ts";
import type { LocalProjectMapping } from "../mappings/types.ts";
import type { SavedSshServer } from "../servers/types.ts";

export interface SyncLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxDepth: number;
  maxSymlinks: number;
}

export const DEFAULT_SYNC_LIMITS: SyncLimits = {
  maxFiles: 20_000,
  maxFileBytes: 100 * 1024 * 1024,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
  maxDepth: 64,
  maxSymlinks: 1_000,
};

export type LocalManifestEntry =
  | { type: "file"; relativePath: string; absolutePath: string; size: number; sha256: string; executable: boolean }
  | { type: "directory"; relativePath: string }
  | { type: "symlink"; relativePath: string; target: string };

export interface LocalMirrorManifest {
  version: 1;
  mode: "git" | "filesystem";
  projectRoot: string;
  generatedAt: string;
  entries: Map<string, LocalManifestEntry>;
  totalBytes: number;
}

export type RemoteMirrorEntry =
  | { type: "file"; relativePath: string; size: number; executable?: boolean }
  | { type: "directory"; relativePath: string }
  | { type: "symlink"; relativePath: string; target: string }
  | { type: "other"; relativePath: string };

export interface MirrorMarker {
  version: 1;
  markerId: string;
  mappingId: string;
  projectId: string;
  remoteRoot: string;
  createdAt: string;
}

export interface MirrorConnection {
  adapter: RemoteAdapter;
  workspace: RemoteWorkspace;
}

export interface SyncSnapshot {
  mapping: LocalProjectMapping;
  server: SavedSshServer;
  localManifest: LocalMirrorManifest;
  connection: MirrorConnection;
  mappingGeneration: number;
  localGeneration: number;
  isGenerationCurrent(): boolean;
}

export interface SyncPlan {
  createDirectories: string[];
  uploadFiles: string[];
  createSymlinks: string[];
  replaceTypeConflicts: string[];
  deleteFiles: string[];
  deleteSymlinks: string[];
  deleteDirectories: string[];
  protectedPaths: string[];
}

export interface SyncMutationSummary {
  createdDirectories: string[];
  uploadedFiles: string[];
  createdSymlinks: string[];
  deletedFiles: string[];
  deletedDirectories: string[];
  protectedPaths: string[];
  bytesUploaded: number;
}

export interface VerificationMismatch {
  path: string;
  kind: "missing" | "unexpected" | "type" | "content" | "symlink" | "executable" | "read";
  message: string;
}

export interface VerificationReport {
  matches: boolean;
  verifiedFiles: number;
  mismatches: VerificationMismatch[];
  remoteEntries: RemoteMirrorEntry[];
}

export interface SyncResult {
  result: "success" | "stale";
  generation: number;
  manifestMode: LocalMirrorManifest["mode"];
  summary: SyncMutationSummary;
  verifiedFiles: number;
  repaired: boolean;
}

export type SyncReason = "startup" | "resume" | "reload" | "ssh-exit" | "mapping-created" | "mapping-resumed" | "file-change" | "manual-command" | "tool" | "exec-barrier";

export interface SyncAuditRecord {
  timestamp: string;
  reason: SyncReason;
  generation: number;
  uploaded: string[];
  deleted: string[];
  protected: string[];
  verifiedFiles: number;
  result: "success" | "failed" | "cancelled" | "stale";
  error?: string;
}
