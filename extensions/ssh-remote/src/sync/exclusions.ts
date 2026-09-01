import { posix } from "node:path";

const HARD_LOCAL_PATTERNS = [
  ".git/**", ".pi-ssh-sync.json", ".ssh/**", "**/.ssh/**",
  "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519",
  "**/id_rsa", "**/id_dsa", "**/id_ecdsa", "**/id_ed25519",
];
const DEFAULT_LOCAL_PATTERNS = [
  ".git/**", "node_modules/**", "coverage/**", ".cache/**", ".DS_Store", "Thumbs.db",
  ".env", ".env.*", "!.env.example", "!.env.sample", "!.env.template",
];
const PRIVATE_KEY_HEADERS = [
  "BEGIN OPENSSH PRIVATE KEY", "BEGIN RSA PRIVATE KEY", "BEGIN EC PRIVATE KEY", "BEGIN DSA PRIVATE KEY",
];

function normalize(value: string): string {
  const path = value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!path || path.startsWith("/") || path.split("/").includes("..") || /[\0\r\n]/.test(path)) {
    throw new Error(`Unsafe mirror relative path: ${JSON.stringify(value)}`);
  }
  return posix.normalize(path);
}

function globRegex(pattern: string): RegExp {
  const value = normalize(pattern);
  let source = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "/" && value.slice(index) === "/**") {
      source += "(?:/.*)?";
      index += 2;
    } else if (char === "*" && value[index + 1] === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return new RegExp(`^(?:${source})(?:$|/)`);
}

function matchOrdered(path: string, patterns: readonly string[], caseInsensitive: boolean): boolean {
  let matched = false;
  const candidate = caseInsensitive ? normalize(path).toLowerCase() : normalize(path);
  for (const raw of patterns) {
    const negated = raw.startsWith("!");
    const pattern = negated ? raw.slice(1) : raw;
    const comparable = caseInsensitive ? pattern.toLowerCase() : pattern;
    if (globRegex(comparable).test(candidate)) matched = !negated;
  }
  return matched;
}

export class MirrorExclusions {
  private readonly localPatterns: string[];
  private readonly remotePatterns: string[];
  constructor(localPatterns: readonly string[], remotePatterns: readonly string[], private readonly windowsRemote = false) {
    this.localPatterns = [...HARD_LOCAL_PATTERNS, ...DEFAULT_LOCAL_PATTERNS, ...localPatterns];
    this.remotePatterns = [...remotePatterns];
  }
  withLocalPatterns(patterns: readonly string[]): MirrorExclusions {
    return new MirrorExclusions([...this.localPatterns, ...patterns], this.remotePatterns, this.windowsRemote);
  }
  isHardLocalExcluded(path: string): boolean { return matchOrdered(path, HARD_LOCAL_PATTERNS, false); }
  isLocalExcluded(path: string): boolean { return this.isHardLocalExcluded(path) || matchOrdered(path, this.localPatterns, false); }
  mayReincludeDescendant(directory: string): boolean {
    const prefix = `${normalize(directory)}/`;
    return this.localPatterns.some((pattern) => pattern.startsWith("!") && normalize(pattern.slice(1)).startsWith(prefix));
  }
  isRemoteProtected(path: string): boolean {
    const normalized = normalize(path);
    if ((this.windowsRemote ? normalized.toLowerCase() : normalized) === ".pi-ssh-sync.json") return true;
    return matchOrdered(path, this.remotePatterns, this.windowsRemote);
  }
  assertSafeRelative(path: string): string { return normalize(path); }
}

export function containsPrivateKeyMaterial(content: Buffer): boolean {
  const prefix = content.subarray(0, Math.min(content.length, 16 * 1024)).toString("utf8");
  return PRIVATE_KEY_HEADERS.some((header) => prefix.includes(header));
}
