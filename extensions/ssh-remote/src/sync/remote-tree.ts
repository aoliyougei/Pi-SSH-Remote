import { randomUUID } from "node:crypto";
import { posix, win32 } from "node:path";
import { shellQuote } from "../workspace/target.ts";
import type { RemoteAdapter, RemoteWorkspace } from "../adapters/types.ts";
import type { RemoteMirrorEntry, SyncLimits } from "./types.ts";
import { DEFAULT_SYNC_LIMITS } from "./types.ts";
import { MirrorExclusions } from "./exclusions.ts";

export class RemoteMirrorFs {
  private readonly api: typeof posix | typeof win32;
  constructor(readonly adapter: RemoteAdapter, readonly workspace: RemoteWorkspace, readonly root: string) {
    this.api = workspace.platform === "windows" ? win32 : posix;
  }
  native(relativePath = ""): string {
    if (relativePath && (this.api.isAbsolute(relativePath) || /[\0\r\n]/.test(relativePath))) throw new Error(`Unsafe remote mirror path: ${relativePath}`);
    const root = this.api.resolve(this.root);
    const absolute = this.api.resolve(root, relativePath.replace(/\//g, this.api.sep));
    const fromRoot = this.api.relative(root, absolute);
    if (fromRoot === ".." || fromRoot.startsWith(`..${this.api.sep}`) || this.api.isAbsolute(fromRoot)) throw new Error(`Remote mirror path escapes authorized root: ${relativePath}`);
    return absolute;
  }
  tool(relativePath = ""): string { return this.adapter.toToolPath(this.native(relativePath), this.workspace); }

  async scan(exclusions: MirrorExclusions, signal?: AbortSignal, limits: SyncLimits = DEFAULT_SYNC_LIMITS): Promise<RemoteMirrorEntry[]> {
    const output: RemoteMirrorEntry[] = [];
    const queue = [{ path: "", depth: 0 }];
    while (queue.length) {
      signal?.throwIfAborted();
      const current = queue.shift()!;
      if (current.depth > limits.maxDepth) throw new Error("Remote mirror depth limit exceeded");
      for (const item of await this.adapter.listDirectory(this.tool(current.path), signal)) {
        const path = current.path ? `${current.path}/${item.name}` : item.name;
        if (exclusions.isRemoteProtected(path)) { output.push({ type: "directory", relativePath: path }); continue; }
        const stat = await this.adapter.statPath(this.tool(path), signal);
        if (stat.type === "directory") { output.push({ type: "directory", relativePath: path }); queue.push({ path, depth: current.depth + 1 }); }
        else if (stat.type === "file") output.push({ type: "file", relativePath: path, size: stat.size, executable: this.workspace.platform === "unix" ? await this.isExecutable(path, signal) : undefined });
        else if (stat.type === "symlink") output.push({ type: "symlink", relativePath: path, target: await this.readLink(path, signal) });
        else output.push({ type: "other", relativePath: path });
        if (output.length > limits.maxFiles + limits.maxSymlinks + 10_000) throw new Error("Remote mirror entry limit exceeded");
      }
    }
    return output;
  }

  async isExecutable(path: string, signal?: AbortSignal): Promise<boolean> {
    if (this.workspace.platform !== "unix") return false;
    return await this.adapter.runShell(`test -x ${shellQuote(this.native(path))}`, this.workspace.cwd, { signal }) === 0;
  }

  async readLink(path: string, signal?: AbortSignal): Promise<string> {
    const chunks: Buffer[] = [];
    const command = this.workspace.platform === "windows"
      ? `[Console]::Out.Write((Get-Item -LiteralPath '${this.native(path).replace(/'/g, "''")}' -Force).Target)`
      : `readlink -- ${shellQuote(this.native(path))}`;
    const code = await this.adapter.runShell(command, this.workspace.cwd, { signal, captureOutput: false, onStdout: (data) => chunks.push(Buffer.from(data)) });
    if (code !== 0) throw new Error(`Could not read remote symlink: ${path}`);
    return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
  }

  async writeAtomic(path: string, content: Buffer, executable: boolean, signal?: AbortSignal): Promise<void> {
    const target = this.native(path), suffix = `.pi-ssh-upload-${randomUUID()}`;
    const temporary = `${target}${suffix}`;
    await this.adapter.mkdir(this.adapter.toToolPath(this.api.dirname(target), this.workspace), signal);
    await this.adapter.writeFile(this.adapter.toToolPath(temporary, this.workspace), content, signal);
    const command = this.workspace.platform === "windows"
      ? `try { Move-Item -LiteralPath '${temporary.replace(/'/g, "''")}' -Destination '${target.replace(/'/g, "''")}' -Force } finally { if (Test-Path -LiteralPath '${temporary.replace(/'/g, "''")}') { Remove-Item -LiteralPath '${temporary.replace(/'/g, "''")}' -Force -ErrorAction SilentlyContinue } }`
      : `trap 'rm -f -- ${shellQuote(temporary)}' EXIT HUP INT TERM; ${executable ? `chmod 755 ${shellQuote(temporary)} && ` : ""}mv -f -- ${shellQuote(temporary)} ${shellQuote(target)}; status=$?; trap - EXIT HUP INT TERM; rm -f -- ${shellQuote(temporary)}; exit $status`;
    const code = await this.adapter.runShell(command, this.workspace.cwd, { signal });
    if (code !== 0) throw new Error(`Could not replace remote file: ${path}`);
  }

  async createSymlink(path: string, target: string, signal?: AbortSignal): Promise<void> {
    const native = this.native(path);
    const command = this.workspace.platform === "windows"
      ? `New-Item -ItemType SymbolicLink -Path '${native.replace(/'/g, "''")}' -Target '${target.replace(/'/g, "''")}' -Force | Out-Null`
      : `ln -sfn -- ${shellQuote(target)} ${shellQuote(native)}`;
    if (await this.adapter.runShell(command, this.workspace.cwd, { signal }) !== 0) throw new Error(`Could not create remote symlink: ${path}`);
  }

  async remove(path: string, directory: boolean, signal?: AbortSignal): Promise<void> {
    const native = this.native(path);
    const command = this.workspace.platform === "windows"
      ? `Remove-Item -LiteralPath '${native.replace(/'/g, "''")}' -Force${directory ? "" : ""}`
      : directory ? `rmdir -- ${shellQuote(native)}` : `rm -f -- ${shellQuote(native)}`;
    if (await this.adapter.runShell(command, this.workspace.cwd, { signal }) !== 0) throw new Error(`Could not remove remote path: ${path}`);
  }
}
