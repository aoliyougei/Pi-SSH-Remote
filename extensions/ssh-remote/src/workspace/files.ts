import { posix, win32 } from "node:path";
import {
  collectWorkspaceFile,
  registerWorkspaceFileProvider,
  registerWorkspaceFileProviderV2,
  type WorkspaceFileSystem,
  type WorkspaceFileSystemV2,
} from "@aoliyougei/pi-workspace-files";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RemoteAdapter, RemoteWorkspace } from "../adapters/index.ts";

export interface RemoteWorkspaceFileConnection {
  adapter: RemoteAdapter;
  workspace: RemoteWorkspace;
}

function pathApi(workspace: RemoteWorkspace): typeof posix | typeof win32 {
  return workspace.platform === "windows" ? win32 : posix;
}

function isInsideWorkspace(workspace: RemoteWorkspace, nativePath: string): boolean {
  const api = pathApi(workspace);
  const root = api.resolve(workspace.cwd);
  const absolute = api.resolve(nativePath);
  const relative = api.relative(root, absolute);
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${api.sep}`)
    && !api.isAbsolute(relative)
  );
}

function assertWorkspacePath(workspace: RemoteWorkspace, path: string): string {
  const nativePath = pathApi(workspace).resolve(path);
  if (!isInsideWorkspace(workspace, nativePath)) {
    throw new Error(`Path must stay inside the remote workspace: ${path}`);
  }
  return nativePath;
}

function createRemoteWorkspaceFiles(
  connection: RemoteWorkspaceFileConnection,
  localCwd: string,
): WorkspaceFileSystem {
  const { adapter, workspace } = connection;
  const api = pathApi(workspace);
  const toolPath = (path: string): string =>
    adapter.toToolPath(assertWorkspacePath(workspace, path), workspace);

  return {
    resolvePath(path) {
      return assertWorkspacePath(
        workspace,
        adapter.mapCwd(path, localCwd, workspace),
      );
    },
    extname: (path) => api.extname(path),
    dirname: (path) => api.dirname(path),
    exists: (path, options) =>
      adapter.fileExists(toolPath(path), options?.signal),
    readFile: (path, options) =>
      adapter.readFile(toolPath(path), options?.signal),
    mkdir: (path, options) =>
      adapter.mkdir(toolPath(path), options?.signal),
    async writeFile(path, content, options) {
      const bytes = await collectWorkspaceFile(content, options);
      await adapter.writeFile(toolPath(path), bytes, options?.signal);
    },
  };
}

function createRemoteWorkspaceFilesV2(
  connection: RemoteWorkspaceFileConnection,
  localCwd: string,
): WorkspaceFileSystemV2 {
  const base = createRemoteWorkspaceFiles(connection, localCwd);
  const { adapter, workspace } = connection;
  const toolPath = (path: string): string => adapter.toToolPath(assertWorkspacePath(workspace, path), workspace);
  return {
    ...base,
    stat: (path, options) => adapter.statPath(toolPath(path), options?.signal),
    async listDirectory(path, options) {
      const entries = await adapter.listDirectory(toolPath(path), options?.signal);
      return Promise.all(entries.map(async (entry) => {
        const value = await adapter.statPath(toolPath(pathApi(workspace).join(assertWorkspacePath(workspace, path), entry.name)), options?.signal);
        return { name: entry.name, type: value.type, size: value.size };
      }));
    },
  };
}

function unavailableWorkspaceFilesV2(message: string): WorkspaceFileSystemV2 {
  const fail = async () => { throw new Error(message); };
  return { resolvePath: fail as never, extname: () => "", dirname: () => "", exists: fail, readFile: fail, mkdir: fail, writeFile: fail, stat: fail, listDirectory: fail };
}

export function registerRemoteWorkspaceFiles(
  pi: ExtensionAPI,
  getConnection: () => RemoteWorkspaceFileConnection | undefined,
  getUnavailableMessage?: () => string | undefined,
): void {
  registerWorkspaceFileProvider(
    pi,
    "@aoliyougei/pi-ssh-remote",
    ({ cwd }) => {
      const connection = getConnection();
      return connection ? createRemoteWorkspaceFiles(connection, cwd) : undefined;
    },
  );
  registerWorkspaceFileProviderV2(
    pi,
    "@aoliyougei/pi-ssh-remote",
    ({ cwd }) => {
      const connection = getConnection();
      if (connection) return createRemoteWorkspaceFilesV2(connection, cwd);
      const message = getUnavailableMessage?.();
      return message ? unavailableWorkspaceFilesV2(message) : undefined;
    },
  );
}
