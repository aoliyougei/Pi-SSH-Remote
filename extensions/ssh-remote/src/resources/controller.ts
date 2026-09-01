import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RemoteAdapter, RemoteWorkspace } from "../adapters/types.ts";

const AGENTS = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
const MAX_FILES = 2000, MAX_SIZE = 1024 * 1024, MAX_TOTAL = 20 * 1024 * 1024;
type FileData = { path: string; content: Buffer; sha256: string };
export type RemoteResourceSnapshot = { digest: string; agents?: FileData; skills: Array<{ name: string; root: string; files: FileData[] }> };
const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

async function read(adapter: RemoteAdapter, workspace: RemoteWorkspace, path: string): Promise<FileData> {
  const content = await adapter.readFile(adapter.toToolPath(posix.join(workspace.cwd, path), workspace));
  if (content.length > MAX_SIZE) throw new Error(`Remote resource too large: ${path}`);
  return { path, content, sha256: hash(content) };
}

export async function scanRemoteResources(adapter: RemoteAdapter, workspace: RemoteWorkspace): Promise<RemoteResourceSnapshot> {
  if (workspace.platform !== "unix") return { digest: hash(JSON.stringify({ platform: workspace.platform })), skills: [] };
  let agents: FileData | undefined;
  for (const name of AGENTS) {
    if (await adapter.fileExists(adapter.toToolPath(posix.join(workspace.cwd, name), workspace))) { agents = await read(adapter, workspace, name); break; }
  }
  const skills: RemoteResourceSnapshot["skills"] = [];
  let count = 0, total = agents?.content.length ?? 0;
  for (const base of [".pi/skills", ".agents/skills"]) {
    const basePath = adapter.toToolPath(posix.join(workspace.cwd, base), workspace);
    let roots;
    try { roots = await adapter.listDirectory(basePath); } catch { continue; }
    for (const root of roots.filter((entry) => entry.isDirectory)) {
      const skillFile = adapter.toToolPath(posix.join(workspace.cwd, base, root.name, "SKILL.md"), workspace);
      if (!await adapter.fileExists(skillFile)) continue;
      const files: FileData[] = [], queue = [{ rel: "", depth: 0 }];
      while (queue.length) {
        const current = queue.shift()!;
        if (current.depth > 10) throw new Error("Remote Skill depth limit exceeded");
        const directory = posix.join(base, root.name, current.rel);
        for (const entry of await adapter.listDirectory(adapter.toToolPath(posix.join(workspace.cwd, directory), workspace))) {
          if (entry.name === ".git" || entry.name === "node_modules") continue;
          const relative = posix.join(current.rel, entry.name);
          const stat = await adapter.statPath(adapter.toToolPath(posix.join(workspace.cwd, base, root.name, relative), workspace));
          if (stat.type === "symlink" || stat.type === "other") throw new Error(`Unsupported remote resource: ${relative}`);
          if (stat.type === "directory") queue.push({ rel: relative, depth: current.depth + 1 });
          else {
            const file = await read(adapter, workspace, posix.join(base, root.name, relative));
            count += 1; total += file.content.length;
            if (count > MAX_FILES || total > MAX_TOTAL) throw new Error("Remote resource limits exceeded");
            files.push({ ...file, path: relative });
          }
        }
      }
      if (files.some((file) => file.path === "SKILL.md")) skills.push({ name: root.name, root: posix.join(base, root.name), files });
    }
  }
  const core = { agents: agents && { path: agents.path, sha256: agents.sha256 }, skills: skills.map((skill) => ({ name: skill.name, root: skill.root, files: skill.files.map((file) => ({ path: file.path, sha256: file.sha256 })).sort((a, b) => a.path.localeCompare(b.path)) })).sort((a, b) => a.name.localeCompare(b.name)) };
  return { agents, skills, digest: hash(JSON.stringify(core)) };
}

function wrapSkill(source: string, remoteRoot: string): string {
  const notice = `\n\n> Remote skill source: ${remoteRoot}\n> Resolve relative references and scripts against that remote root. Use the active SSH workspace tools. Never execute files from the local cache path.\n`;
  if (source.startsWith("---\n")) { const end = source.indexOf("\n---", 4); if (end >= 0) return source.slice(0, end + 4) + notice + source.slice(end + 4); }
  return notice.trimStart() + source;
}

async function stage(snapshot: RemoteResourceSnapshot, workspace: RemoteWorkspace, cacheRoot = join(getAgentDir(), "remote-projects", "tmp")) {
  const dir = join(cacheRoot, randomUUID()); await mkdir(dir, { recursive: true, mode: 0o700 }); await chmod(dir, 0o700);
  const skillPaths: string[] = [];
  for (const skill of snapshot.skills) {
    const root = join(dir, "skills", skill.name);
    for (const file of skill.files) {
      const output = join(root, file.path); await mkdir(join(output, ".."), { recursive: true, mode: 0o700 });
      const content = file.path === "SKILL.md" ? Buffer.from(wrapSkill(file.content.toString("utf8"), posix.join(workspace.cwd, skill.root))) : file.content;
      await writeFile(output, content, { mode: 0o600 }); await chmod(output, 0o600);
    }
    skillPaths.push(root);
  }
  return { dir, skillPaths, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

type Transaction = { snapshot: RemoteResourceSnapshot; cache: Awaited<ReturnType<typeof stage>>; identity: string };
const transactions = new Map<string, Transaction>();

export class RemoteResourceController {
  private sessionId?: string;
  constructor(private readonly cacheRoot?: string) {}
  private transaction() { return this.sessionId ? transactions.get(this.sessionId) : undefined; }
  clear(preserveForReload = false) { if (!this.sessionId || preserveForReload) return; const value = transactions.get(this.sessionId); transactions.delete(this.sessionId); void value?.cache.cleanup(); }
  get skillPaths() { return this.transaction()?.cache.skillPaths ?? []; }
  async enter(adapter: RemoteAdapter, workspace: RemoteWorkspace, ctx: ExtensionContext): Promise<boolean> {
    this.sessionId = ctx.sessionManager.getSessionId();
    const identity = `${workspace.platform}:${workspace.cwd}`;
    const existing = this.transaction();
    if (workspace.platform !== "unix") { this.clear(); return false; }
    const snapshot = await scanRemoteResources(adapter, workspace);
    if (existing?.identity === identity && existing.snapshot.digest === snapshot.digest) return existing.cache.skillPaths.length > 0;
    this.clear();
    if (!snapshot.agents && snapshot.skills.length === 0) return false;
    if (!ctx.hasUI) return false;
    const choice = await ctx.ui.select(`Load remote project resources?\n${workspace.cwd}\nAGENTS: ${snapshot.agents ? snapshot.agents.path : "none"}\nSkills: ${snapshot.skills.length}\nDigest: ${snapshot.digest}\nSkill scripts run on the SSH server.`, ["Load for this entry", "Do not load"]);
    if (choice !== "Load for this entry") return false;
    const cache = await stage(snapshot, workspace, this.cacheRoot);
    transactions.set(this.sessionId, { snapshot, cache, identity });
    return cache.skillPaths.length > 0;
  }
  async beforeTurn(adapter: RemoteAdapter, workspace: RemoteWorkspace, systemPrompt: string) {
    const transaction = this.transaction();
    if (!transaction) return systemPrompt;
    const next = await scanRemoteResources(adapter, workspace);
    if (next.digest !== transaction.snapshot.digest) { this.clear(); throw new Error("Remote project resources changed; reconnect or change directory to review them again"); }
    if (!next.agents) return systemPrompt;
    return `${systemPrompt}\n\n# Remote Project Context\nSource: ssh://${workspace.cwd}/${next.agents.path}\nDigest: ${next.agents.sha256}\n\n${next.agents.content.toString("utf8")}`;
  }
}
