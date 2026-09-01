export const SSH_MAPPING_STORE_VERSION = 1 as const;
export const SSH_PROJECT_MAPPING_VERSION = 1 as const;
export const DEFAULT_MIRROR_DEBOUNCE_MS = 1_500;
export const MIN_MIRROR_DEBOUNCE_MS = 250;
export const MAX_MIRROR_DEBOUNCE_MS = 30_000;

export const DEFAULT_REMOTE_PROTECTED_PATTERNS = [
  ".pi-ssh-sync.json",
  ".env",
  ".env.*",
  "!.env.example",
  "!.env.sample",
  "!.env.template",
  "node_modules/**",
  "logs/**",
  "uploads/**",
  "runtime/**",
  "tmp/**",
  "*.pid",
] as const;

export interface LocalProjectMapping {
  version: typeof SSH_PROJECT_MAPPING_VERSION;
  id: string;
  projectId: string;
  localRoot: string;
  localRootCanonical: string;
  matchSubdirectories: boolean;
  serverId: string;
  remoteRoot: string;
  autoSync: boolean;
  debounceMs: number;
  localExcludePatterns: string[];
  remoteProtectedPatterns: string[];
  markerId: string;
  paused: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MappingStoreDocument {
  version: typeof SSH_MAPPING_STORE_VERSION;
  mappings: LocalProjectMapping[];
}
