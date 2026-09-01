export type ExecConfirmationPolicy = "never" | "destructive" | "always";

const DESTRUCTIVE_PATTERNS = [
  /(?:^|[;&|]\s*)rm\s+(?:-[^\s]*r[^\s]*f|-[^\s]*f[^\s]*r)\s+(?:\/|~)(?:\s|$|\*)/i,
  /\b(?:shutdown|reboot|halt|poweroff)\b/i,
  /\b(?:mkfs(?:\.[a-z0-9]+)?|fdisk|parted)\b/i,
  /\bdd\s+[^;&|]*(?:of=\/dev\/|if=\/dev\/(?:zero|urandom))/i,
  /(?:>|tee\s+)\s*\/dev\/(?:sd|nvme|vd)[a-z0-9]*/i,
  /:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:[^}]*\}/,
  /\bchmod\s+-R\s+0+\s+\//i,
  /\bchown\s+-R\s+root(?::root)?\s+\//i,
];

export function isDestructiveRemoteCommand(command: string): boolean {
  return DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(command));
}

export function requiresExecConfirmation(policy: ExecConfirmationPolicy, command: string): boolean {
  return policy === "always" || (policy === "destructive" && isDestructiveRemoteCommand(command));
}
