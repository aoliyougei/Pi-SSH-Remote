import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import ssh2 from "ssh2";

const MAX_PRIVATE_KEY_BYTES = 1024 * 1024;

export interface ManagedKeyTransaction {
  readonly path: string;
  readonly existed: boolean;
  commit(): void;
  rollback(): Promise<void>;
}

export function getManagedSshDirectory(agentDir = getAgentDir()): string {
  return join(agentDir, "ssh");
}

export function getDefaultOpenSshConfigPath(agentDir = getAgentDir()): string {
  return join(getManagedSshDirectory(agentDir), "config");
}

export function getManagedKeyPath(fileName: string, directory = getManagedSshDirectory()): string {
  return join(directory, validateManagedKeyName(fileName));
}

export function isManagedKeyPath(path: string, directory = getManagedSshDirectory()): boolean {
  return dirname(resolve(path)) === resolve(directory);
}

export function validateManagedKeyName(value: string): string {
  const name = value.trim();
  if (!name || name === "." || name === ".." || !/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error("密钥文件名只能包含字母、数字、点、下划线和连字符，且不能是 . 或 ..");
  }
  return name;
}

export async function validatePrivateKey(contents: string): Promise<void> {
  if (!contents.trim()) throw new Error("私钥不能为空");
  if (Buffer.byteLength(contents) > MAX_PRIVATE_KEY_BYTES) throw new Error("私钥不能超过 1 MiB");
  if (/-----BEGIN ENCRYPTED PRIVATE KEY-----/.test(contents)) {
    throw new Error("不支持加密私钥，请使用 SSH Agent 或未加密的专用密钥");
  }
  const parsed = ssh2.utils.parseKey(contents);
  if (parsed instanceof Error) {
    if (/encrypted|passphrase/i.test(parsed.message)) {
      throw new Error("不支持加密私钥，请使用 SSH Agent 或未加密的专用密钥");
    }
    throw new Error("私钥格式无效");
  }
  const keys = Array.isArray(parsed) ? parsed : [parsed];
  if (!keys.some((key) => key.isPrivateKey())) throw new Error("输入内容不是私钥");
}

function publish(path: string, contents: string | Buffer, mode: number): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, contents, { mode: 0o600, flag: "wx" });
    chmodSync(temporary, mode);
    renameSync(temporary, path);
    chmodSync(path, mode);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export async function stageManagedKey(
  fileName: string,
  contents: string,
  directory = getManagedSshDirectory(),
): Promise<ManagedKeyTransaction> {
  const name = validateManagedKeyName(fileName);
  await validatePrivateKey(contents);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryStat = lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error("SSH 密钥托管目录必须是普通目录，不能是符号链接");
  }
  chmodSync(directory, 0o700);
  const path = join(directory, name);
  if (resolve(path) !== join(resolve(directory), name)) throw new Error("密钥文件路径超出托管目录");

  let previous: Buffer | undefined;
  let previousMode: number | undefined;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("已有密钥路径不是普通文件，不能覆盖");
    previous = readFileSync(path);
    previousMode = stat.mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  publish(path, contents.endsWith("\n") ? contents : `${contents}\n`, 0o600);
  let active = true;
  return {
    path,
    existed: previous !== undefined,
    commit: () => { active = false; previous = undefined; },
    rollback: async () => {
      if (!active) return;
      active = false;
      if (previous === undefined) rmSync(path, { force: true });
      else publish(path, previous, previousMode ?? 0o600);
      previous = undefined;
    },
  };
}
