import {
  getSharedSettingsPath,
  readSettingsNamespace,
  writeSettingsNamespace,
} from "@aoliyougei/pi-shared-settings";
import type { SshTransportPreference } from "./transport/client.ts";
import type { ExecConfirmationPolicy } from "./exec/policy.ts";

export interface SshRemoteConfig {
  transport: SshTransportPreference;
  /** Ask for an SSH password in the TUI when key/agent auth fails. */
  passwordPrompt: boolean;
  /** Persist entered passwords to a restricted secrets file for -r resumes. */
  persistPasswords: boolean;
  /** Expose tools that let the model connect, exit, inspect, or change SSH cwd. */
  aiControlTools: boolean;
  /** Allow model-triggered SSH connections to authenticate with a password. */
  aiPasswordAuth: boolean;
  /** Expose independent ssh_exec/ssh_sync/server-listing tools when applicable. */
  remoteExecutionTools: boolean;
  /** User confirmation policy for independent remote commands. */
  execConfirmation: ExecConfirmationPolicy;
  /** Default timeout for ssh_exec, in seconds. */
  execTimeoutSeconds: number;
  /** Optional saved server used when no project mapping or explicit name applies. */
  defaultServerId?: string;
}

export const SSH_REMOTE_SETTINGS_NAMESPACE = "ssh-remote";

export const DEFAULT_SSH_REMOTE_CONFIG: SshRemoteConfig = {
  transport: "auto",
  passwordPrompt: true,
  persistPasswords: true,
  aiControlTools: false,
  aiPasswordAuth: true,
  remoteExecutionTools: true,
  execConfirmation: "destructive",
  execTimeoutSeconds: 120,
};

export function normalizeSshRemoteConfig(value: unknown): SshRemoteConfig {
  if (!value || typeof value !== "object") return { ...DEFAULT_SSH_REMOTE_CONFIG };
  const transport = (value as { transport?: unknown }).transport;
  const passwordPrompt = (value as { passwordPrompt?: unknown }).passwordPrompt;
  const persistPasswords = (value as { persistPasswords?: unknown }).persistPasswords;
  const aiControlTools = (value as { aiControlTools?: unknown }).aiControlTools;
  const aiPasswordAuth = (value as { aiPasswordAuth?: unknown }).aiPasswordAuth;
  const remoteExecutionTools = (value as { remoteExecutionTools?: unknown }).remoteExecutionTools;
  const execConfirmation = (value as { execConfirmation?: unknown }).execConfirmation;
  const execTimeoutSeconds = (value as { execTimeoutSeconds?: unknown }).execTimeoutSeconds;
  const defaultServerId = (value as { defaultServerId?: unknown }).defaultServerId;
  return {
    transport: transport === "openssh" || transport === "ssh2" || transport === "auto"
      ? transport
      : DEFAULT_SSH_REMOTE_CONFIG.transport,
    passwordPrompt: typeof passwordPrompt === "boolean"
      ? passwordPrompt
      : DEFAULT_SSH_REMOTE_CONFIG.passwordPrompt,
    persistPasswords: typeof persistPasswords === "boolean"
      ? persistPasswords
      : DEFAULT_SSH_REMOTE_CONFIG.persistPasswords,
    aiControlTools: typeof aiControlTools === "boolean"
      ? aiControlTools
      : DEFAULT_SSH_REMOTE_CONFIG.aiControlTools,
    aiPasswordAuth: typeof aiPasswordAuth === "boolean"
      ? aiPasswordAuth
      : DEFAULT_SSH_REMOTE_CONFIG.aiPasswordAuth,
    remoteExecutionTools: typeof remoteExecutionTools === "boolean"
      ? remoteExecutionTools
      : DEFAULT_SSH_REMOTE_CONFIG.remoteExecutionTools,
    execConfirmation: execConfirmation === "never" || execConfirmation === "destructive" || execConfirmation === "always"
      ? execConfirmation
      : DEFAULT_SSH_REMOTE_CONFIG.execConfirmation,
    execTimeoutSeconds: typeof execTimeoutSeconds === "number" && Number.isInteger(execTimeoutSeconds) && execTimeoutSeconds >= 1 && execTimeoutSeconds <= 86_400
      ? execTimeoutSeconds
      : DEFAULT_SSH_REMOTE_CONFIG.execTimeoutSeconds,
    defaultServerId: typeof defaultServerId === "string" && defaultServerId.length > 0 && !/[\0\r\n]/.test(defaultServerId)
      ? defaultServerId
      : undefined,
  };
}

export function getSshRemoteConfigPath(): string {
  return getSharedSettingsPath();
}

export function loadSshRemoteConfig(path = getSshRemoteConfigPath()): SshRemoteConfig {
  return readSettingsNamespace(SSH_REMOTE_SETTINGS_NAMESPACE, normalizeSshRemoteConfig, path);
}

export function saveSshRemoteConfig(
  config: SshRemoteConfig,
  path = getSshRemoteConfigPath(),
): void {
  writeSettingsNamespace(SSH_REMOTE_SETTINGS_NAMESPACE, normalizeSshRemoteConfig(config), path);
}
