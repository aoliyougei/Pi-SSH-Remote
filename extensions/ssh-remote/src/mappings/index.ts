export {
  DEFAULT_MIRROR_DEBOUNCE_MS,
  DEFAULT_REMOTE_PROTECTED_PATTERNS,
  type LocalProjectMapping,
  type MappingStoreDocument,
} from "./types.ts";
export {
  getMappingStorePath,
  loadMappingStore,
  normalizeMappingStore,
  saveMappingStore,
} from "./store.ts";
export { MappingController, canonicalizeLocalRoot, findProjectMapping } from "./controller.ts";
