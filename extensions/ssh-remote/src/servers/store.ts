import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SshShellPreference } from "../adapters/types.ts";
import type { SshTransportPreference } from "../transport/client.ts";
import {
  SSH_SERVER_STORE_VERSION,
  SSH_SERVER_VERSION,
  type SavedSshServer,
  type SshServerStoreDocument,
} from "./types.ts";

export class UnsupportedStoreVersionError extends Error {
  constructor(readonly store: string, readonly version: unknown) {
    super(`Unsupported ${store} store version: ${String(version)}`);
    this.name = "UnsupportedStoreVersionError";
  }
}

const SHELLS = new Set<SshShellPreference>(["auto", "bash", "zsh", "sh", "pwsh", "powershell"]);
const TRANSPORTS = new Set<SshTransportPreference>(["auto", "openssh", "ssh2"]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function safeString(value: unknown, label: string, optional = false): string | undefined {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string" || !value || /[\0\r\n]/.test(value)) {
    throw new Error(`Invalid SSH server ${label}`);
  }
  return value;
}

function normalizeServer(value: unknown): SavedSshServer {
  const input = record(value);
  if (!input || input.version !== SSH_SERVER_VERSION) throw new Error("Invalid SSH server version");
  const id = safeString(input.id, "id")!;
  const name = safeString(input.name, "name")!;
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`Invalid SSH server name: ${name}`);
  const target = safeString(input.target, "target")!;
  if (target.startsWith("-") || /\s/.test(target)) throw new Error(`Invalid SSH server target: ${target}`);
  const port = input.port === undefined ? undefined : Number(input.port);
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65_535)) {
    throw new Error("Invalid SSH server port");
  }
  const shellPreference = input.shellPreference;
  const transportPreference = input.transportPreference;
  if (!SHELLS.has(shellPreference as SshShellPreference)) throw new Error("Invalid SSH server shell preference");
  if (!TRANSPORTS.has(transportPreference as SshTransportPreference)) throw new Error("Invalid SSH server transport preference");
  return {
    version: SSH_SERVER_VERSION,
    id,
    name,
    description: safeString(input.description, "description", true),
    target,
    port,
    configFile: safeString(input.configFile, "config file", true),
    shellPreference: shellPreference as SshShellPreference,
    transportPreference: transportPreference as SshTransportPreference,
    createdAt: safeString(input.createdAt, "created timestamp")!,
    updatedAt: safeString(input.updatedAt, "updated timestamp")!,
  };
}

export function normalizeServerStore(value: unknown): SshServerStoreDocument {
  if (value === undefined || value === null) return { version: SSH_SERVER_STORE_VERSION, servers: [] };
  const input = record(value);
  if (!input) throw new Error("Invalid SSH server store");
  if (input.version !== SSH_SERVER_STORE_VERSION) {
    throw new UnsupportedStoreVersionError("SSH server", input.version);
  }
  if (!Array.isArray(input.servers)) throw new Error("Invalid SSH server list");
  const servers = input.servers.map(normalizeServer);
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const server of servers) {
    if (ids.has(server.id)) throw new Error(`Duplicate SSH server id: ${server.id}`);
    const name = server.name.toLocaleLowerCase("en-US");
    if (names.has(name)) throw new Error(`Duplicate SSH server name: ${server.name}`);
    ids.add(server.id);
    names.add(name);
  }
  return { version: SSH_SERVER_STORE_VERSION, servers };
}

export function getServerStorePath(): string {
  return join(getAgentDir(), "ssh-remote-servers.json");
}

export function loadServerStore(path = getServerStorePath()): SshServerStoreDocument {
  try {
    return normalizeServerStore(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return normalizeServerStore(undefined);
    throw error;
  }
}

export function saveServerStore(document: SshServerStoreDocument, path = getServerStorePath()): void {
  const normalized = normalizeServerStore(document);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}
