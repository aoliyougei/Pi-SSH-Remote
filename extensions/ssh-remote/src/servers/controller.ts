import type { SavedSshServer, SshServerStoreDocument } from "./types.ts";
import { loadServerStore, normalizeServerStore, saveServerStore } from "./store.ts";

export interface ServerControllerOptions {
  path?: string;
  load?: (path?: string) => SshServerStoreDocument;
  save?: (document: SshServerStoreDocument, path?: string) => void;
}

export class ServerController {
  private document: SshServerStoreDocument;
  private revision = 0;
  private readonly path?: string;
  private readonly saveDocument: NonNullable<ServerControllerOptions["save"]>;

  constructor(options: ServerControllerOptions = {}) {
    this.path = options.path;
    this.document = (options.load ?? loadServerStore)(this.path);
    this.saveDocument = options.save ?? saveServerStore;
  }

  get generation(): number { return this.revision; }
  list(): readonly SavedSshServer[] { return this.document.servers.map((server) => ({ ...server })); }
  get(id: string): SavedSshServer | undefined {
    const value = this.document.servers.find((server) => server.id === id);
    return value ? { ...value } : undefined;
  }
  findByName(name: string): SavedSshServer | undefined {
    const key = name.toLocaleLowerCase("en-US");
    const value = this.document.servers.find((server) => server.name.toLocaleLowerCase("en-US") === key);
    return value ? { ...value } : undefined;
  }

  private commit(servers: SavedSshServer[]): void {
    const next = normalizeServerStore({ version: 1 as const, servers });
    this.saveDocument(next, this.path);
    this.document = next;
    this.revision += 1;
  }

  add(server: SavedSshServer): SavedSshServer {
    if (this.get(server.id)) throw new Error(`SSH server already exists: ${server.id}`);
    if (this.findByName(server.name)) throw new Error(`SSH server name already exists: ${server.name}`);
    this.commit([...this.document.servers, { ...server }]);
    return this.get(server.id)!;
  }

  update(id: string, changes: Partial<Omit<SavedSshServer, "id" | "version">>): SavedSshServer {
    const index = this.document.servers.findIndex((server) => server.id === id);
    if (index < 0) throw new Error(`SSH server not found: ${id}`);
    const candidate = { ...this.document.servers[index], ...changes };
    const collision = this.document.servers.find((server) =>
      server.id !== id && server.name.toLocaleLowerCase("en-US") === candidate.name.toLocaleLowerCase("en-US"));
    if (collision) throw new Error(`SSH server name already exists: ${candidate.name}`);
    const servers = [...this.document.servers];
    servers[index] = candidate;
    this.commit(servers);
    return this.get(candidate.id)!;
  }

  remove(id: string): boolean {
    const servers = this.document.servers.filter((server) => server.id !== id);
    if (servers.length === this.document.servers.length) return false;
    this.commit(servers);
    return true;
  }
}
