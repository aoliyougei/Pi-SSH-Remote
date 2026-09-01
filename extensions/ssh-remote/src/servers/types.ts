import type { SshShellPreference } from "../adapters/types.ts";
import type { SshTransportPreference } from "../transport/client.ts";

export const SSH_SERVER_STORE_VERSION = 1 as const;
export const SSH_SERVER_VERSION = 1 as const;

export interface SavedSshServer {
  version: typeof SSH_SERVER_VERSION;
  id: string;
  name: string;
  description?: string;
  target: string;
  port?: number;
  configFile?: string;
  shellPreference: SshShellPreference;
  transportPreference: SshTransportPreference;
  createdAt: string;
  updatedAt: string;
}

export interface SshServerStoreDocument {
  version: typeof SSH_SERVER_STORE_VERSION;
  servers: SavedSshServer[];
}
