import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, posix, win32 } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { UnsupportedStoreVersionError } from "../servers/store.ts";
import {
  DEFAULT_REMOTE_PROTECTED_PATTERNS,
  MAX_MIRROR_DEBOUNCE_MS,
  MIN_MIRROR_DEBOUNCE_MS,
  SSH_MAPPING_STORE_VERSION,
  SSH_PROJECT_MAPPING_VERSION,
  type LocalProjectMapping,
  type MappingStoreDocument,
} from "./types.ts";

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function safeString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || /[\0\r\n]/.test(value)) throw new Error(`Invalid SSH mapping ${label}`);
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || /[\0\r\n]/.test(entry))) {
    throw new Error(`Invalid SSH mapping ${label}`);
  }
  return [...value];
}

function isAbsoluteRemote(value: string): boolean {
  return posix.isAbsolute(value) || win32.isAbsolute(value) || /^\\\\[^\\]/.test(value);
}

function normalizeMapping(value: unknown): LocalProjectMapping {
  const input = record(value);
  if (!input || input.version !== SSH_PROJECT_MAPPING_VERSION) throw new Error("Invalid SSH mapping version");
  const debounceMs = Number(input.debounceMs);
  if (!Number.isInteger(debounceMs) || debounceMs < MIN_MIRROR_DEBOUNCE_MS || debounceMs > MAX_MIRROR_DEBOUNCE_MS) {
    throw new Error(`Mirror debounce must be from ${MIN_MIRROR_DEBOUNCE_MS} to ${MAX_MIRROR_DEBOUNCE_MS} milliseconds`);
  }
  const localRoot = safeString(input.localRoot, "local root");
  const localRootCanonical = safeString(input.localRootCanonical, "canonical local root");
  const remoteRoot = safeString(input.remoteRoot, "remote root");
  if (!isAbsolute(localRoot) || !isAbsolute(localRootCanonical)) throw new Error("SSH mapping local roots must be absolute");
  if (!isAbsoluteRemote(remoteRoot)) throw new Error("SSH mapping remote root must be absolute");
  const protectedPatterns = stringArray(input.remoteProtectedPatterns, "remote protected patterns");
  const mergedProtected = [...DEFAULT_REMOTE_PROTECTED_PATTERNS, ...protectedPatterns]
    .filter((entry, index, values) => values.indexOf(entry) === index);
  return {
    version: SSH_PROJECT_MAPPING_VERSION,
    id: safeString(input.id, "id"),
    projectId: safeString(input.projectId, "project id"),
    localRoot,
    localRootCanonical,
    matchSubdirectories: input.matchSubdirectories === true,
    serverId: safeString(input.serverId, "server id"),
    remoteRoot,
    autoSync: input.autoSync === true,
    debounceMs,
    localExcludePatterns: stringArray(input.localExcludePatterns, "local exclusions"),
    remoteProtectedPatterns: mergedProtected,
    markerId: safeString(input.markerId, "marker id"),
    paused: input.paused === true,
    createdAt: safeString(input.createdAt, "created timestamp"),
    updatedAt: safeString(input.updatedAt, "updated timestamp"),
  };
}

export function normalizeMappingStore(value: unknown): MappingStoreDocument {
  if (value === undefined || value === null) return { version: SSH_MAPPING_STORE_VERSION, mappings: [] };
  const input = record(value);
  if (!input) throw new Error("Invalid SSH mapping store");
  if (input.version !== SSH_MAPPING_STORE_VERSION) throw new UnsupportedStoreVersionError("SSH mapping", input.version);
  if (!Array.isArray(input.mappings)) throw new Error("Invalid SSH mapping list");
  const mappings = input.mappings.map(normalizeMapping);
  const ids = new Set<string>();
  for (const mapping of mappings) {
    if (ids.has(mapping.id)) throw new Error(`Duplicate SSH mapping id: ${mapping.id}`);
    ids.add(mapping.id);
  }
  return { version: SSH_MAPPING_STORE_VERSION, mappings };
}

export function getMappingStorePath(): string {
  return join(getAgentDir(), "ssh-remote-mappings.json");
}

export function loadMappingStore(path = getMappingStorePath()): MappingStoreDocument {
  try {
    return normalizeMappingStore(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return normalizeMappingStore(undefined);
    throw error;
  }
}

export function saveMappingStore(document: MappingStoreDocument, path = getMappingStorePath()): void {
  const normalized = normalizeMappingStore(document);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}
