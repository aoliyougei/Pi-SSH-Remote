import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";
import type { LocalProjectMapping, MappingStoreDocument } from "./types.ts";
import { loadMappingStore, normalizeMappingStore, saveMappingStore } from "./store.ts";

function looksWindowsPath(value: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value);
}

export function canonicalizeLocalRoot(
  value: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const windows = looksWindowsPath(value, platform);
  let canonical: string;
  if (windows && platform !== "win32") {
    canonical = win32.resolve(value);
  } else {
    const absolute = resolve(value);
    canonical = existsSync(absolute) ? realpathSync.native(absolute) : absolute;
  }
  return windows ? win32.normalize(canonical).toLowerCase() : resolve(canonical);
}

function isInside(root: string, value: string, windows: boolean): boolean {
  const api = windows ? win32 : { relative, isAbsolute, sep };
  const result = api.relative(root, value);
  return result === "" || (result !== ".." && !result.startsWith(`..${api.sep}`) && !api.isAbsolute(result));
}

export function findProjectMapping(
  cwd: string,
  mappings: readonly LocalProjectMapping[],
  platform: NodeJS.Platform = process.platform,
): LocalProjectMapping | undefined {
  const canonicalCwd = canonicalizeLocalRoot(cwd, platform);
  return mappings
    .filter((mapping) => {
      const root = canonicalizeLocalRoot(mapping.localRootCanonical, platform);
      if (root === canonicalCwd) return true;
      return mapping.matchSubdirectories && isInside(root, canonicalCwd, looksWindowsPath(root, platform));
    })
    .sort((left, right) =>
      canonicalizeLocalRoot(right.localRootCanonical, platform).length
      - canonicalizeLocalRoot(left.localRootCanonical, platform).length)[0];
}

export interface MappingControllerOptions {
  path?: string;
  platform?: NodeJS.Platform;
  load?: (path?: string) => MappingStoreDocument;
  save?: (document: MappingStoreDocument, path?: string) => void;
}

export class MappingController {
  private document: MappingStoreDocument;
  private revision = 0;
  private readonly path?: string;
  private readonly platform: NodeJS.Platform;
  private readonly saveDocument: NonNullable<MappingControllerOptions["save"]>;

  constructor(options: MappingControllerOptions = {}) {
    this.path = options.path;
    this.platform = options.platform ?? process.platform;
    this.document = (options.load ?? loadMappingStore)(this.path);
    this.saveDocument = options.save ?? saveMappingStore;
  }

  get generation(): number { return this.revision; }
  list(): readonly LocalProjectMapping[] { return this.document.mappings.map((value) => ({ ...value })); }
  get(id: string): LocalProjectMapping | undefined {
    const value = this.document.mappings.find((mapping) => mapping.id === id);
    return value ? { ...value } : undefined;
  }
  find(cwd: string): LocalProjectMapping | undefined {
    return findProjectMapping(cwd, this.document.mappings, this.platform);
  }

  private commit(mappings: LocalProjectMapping[]): void {
    const next = normalizeMappingStore({ version: 1 as const, mappings });
    this.saveDocument(next, this.path);
    this.document = next;
    this.revision += 1;
  }

  add(mapping: LocalProjectMapping): LocalProjectMapping {
    if (this.get(mapping.id)) throw new Error(`SSH mapping already exists: ${mapping.id}`);
    const canonical = canonicalizeLocalRoot(mapping.localRoot, this.platform);
    const next = { ...mapping, localRootCanonical: canonical };
    this.commit([...this.document.mappings, next]);
    return this.get(next.id)!;
  }

  async updateTransactional(
    id: string,
    changes: Partial<Omit<LocalProjectMapping, "id" | "version">>,
    validate: (candidate: LocalProjectMapping) => void | Promise<void>,
  ): Promise<LocalProjectMapping> {
    const index = this.document.mappings.findIndex((mapping) => mapping.id === id);
    if (index < 0) throw new Error(`SSH mapping not found: ${id}`);
    const candidate = { ...this.document.mappings[index], ...changes };
    if (changes.localRoot !== undefined) candidate.localRootCanonical = canonicalizeLocalRoot(changes.localRoot, this.platform);
    await validate({ ...candidate });
    const mappings = [...this.document.mappings];
    mappings[index] = candidate;
    this.commit(mappings);
    return this.get(candidate.id)!;
  }

  remove(id: string): boolean {
    const mappings = this.document.mappings.filter((mapping) => mapping.id !== id);
    if (mappings.length === this.document.mappings.length) return false;
    this.commit(mappings);
    return true;
  }

  pause(id: string): Promise<LocalProjectMapping> {
    return this.updateTransactional(id, { paused: true }, () => {});
  }

  resume(id: string): Promise<LocalProjectMapping> {
    return this.updateTransactional(id, { paused: false }, () => {});
  }
}
