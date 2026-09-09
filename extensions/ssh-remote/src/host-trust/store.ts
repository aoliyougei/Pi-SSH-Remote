import { randomUUID, createHash } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { ChangedSshHostKeyError, type SshHostKeyCandidate, type SshHostKeyEndpoint } from "./types.ts";

const MAX_KNOWN_HOSTS_BYTES = 16 * 1024 * 1024;

function readSshString(buffer: Buffer, offset: number): { value: Buffer; offset: number } {
  if (offset + 4 > buffer.length) throw new Error("SSH host-key blob 缺少字段长度");
  const length = buffer.readUInt32BE(offset);
  const start = offset + 4;
  const end = start + length;
  if (end > buffer.length) throw new Error("SSH host-key blob 字段不完整");
  return { value: buffer.subarray(start, end), offset: end };
}

export function parseSshHostKeyBlob(key: Buffer, endpoint: SshHostKeyEndpoint): SshHostKeyCandidate {
  const algorithm = readSshString(key, 0).value.toString("ascii");
  if (!algorithm || /[^A-Za-z0-9@._+-]/.test(algorithm)) throw new Error("SSH host-key blob 算法无效");
  const lookupHost = endpoint.hostKeyAlias || (endpoint.port === 22 ? endpoint.host : `[${endpoint.host}]:${endpoint.port}`);
  return {
    ...endpoint,
    lookupHost,
    keyType: algorithm,
    keyBase64: key.toString("base64"),
    fingerprint: `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`,
  };
}

export function getPersistentKnownHostsPath(agentDir = getAgentDir()): string {
  return join(agentDir, "ssh", "known_hosts");
}

function lineHosts(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return [];
  const fields = trimmed.split(/\s+/);
  if (fields[0]?.startsWith("@")) fields.shift();
  return (fields[0] ?? "").split(",");
}

export function trustHostKey(candidate: SshHostKeyCandidate, path = getPersistentKnownHostsPath()): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryStat = lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error("known_hosts 所在目录必须是普通目录，不能是符号链接");
  chmodSync(directory, 0o700);

  let current = "";
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("known_hosts 必须是普通文件，不能是符号链接");
    if (stat.size > MAX_KNOWN_HOSTS_BYTES) throw new Error("known_hosts 不能超过 16 MiB");
    current = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const exact = `${candidate.lookupHost} ${candidate.keyType} ${candidate.keyBase64}`;
  if (current.split(/\r?\n/).some((line) => line.trim() === exact)) {
    if (current) chmodSync(path, 0o600);
    return;
  }
  if (current.split(/\r?\n/).some((line) => lineHosts(line).includes(candidate.lookupHost))) {
    throw new ChangedSshHostKeyError(candidate);
  }

  const next = `${current.replace(/\s*$/, "")}${current.trim() ? "\n" : ""}${exact}\n`;
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    writeFileSync(temporary, next, { encoding: "utf8", mode: 0o600, flag: "wx" });
    descriptor = openSync(temporary, "r");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}
