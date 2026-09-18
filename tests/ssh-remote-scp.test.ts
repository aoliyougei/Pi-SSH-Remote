import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildScpInvocation, runScpProcess, ScpController } from "../extensions/ssh-remote/src/exec/scp.ts";
import type { SavedSshServer } from "../extensions/ssh-remote/src/servers/types.ts";
import { registerRemoteExecutionTools, syncRemoteExecutionActiveTools } from "../extensions/ssh-remote/src/exec/tools.ts";

const server: SavedSshServer = {
  version: 1,
  id: "server-1",
  name: "test-api",
  target: "deploy@devbox",
  port: 2201,
  configFile: "/local/pi-agent/ssh/config",
  authenticationPreference: "key",
  identityFile: "/local/pi-agent/ssh/id_test",
  shellPreference: "auto",
  transportPreference: "auto",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

test("scp invocation keeps paths out of a shell and enforces persistent host trust", () => {
  const invocation = buildScpInvocation({
    action: "upload",
    server,
    localPath: "/local/project/dist/app.tgz",
    remotePath: "/srv/releases/app.tgz",
    recursive: true,
    knownHostsFile: "/local/pi-agent/ssh/known_hosts",
    password: "not-in-arguments",
    platform: "linux",
  });

  assert.equal(invocation.executable, "sshpass");
  assert.deepEqual(invocation.args, [
    "-e", "scp",
    "-F", "/local/pi-agent/ssh/config",
    "-o", "UserKnownHostsFile=/local/pi-agent/ssh/known_hosts",
    "-o", "GlobalKnownHostsFile=/etc/ssh/ssh_known_hosts",
    "-o", "StrictHostKeyChecking=yes",
    "-i", "/local/pi-agent/ssh/id_test",
    "-o", "IdentitiesOnly=no",
    "-o", "PreferredAuthentications=publickey,password,keyboard-interactive",
    "-o", "BatchMode=no",
    "-o", "ConnectTimeout=10",
    "-P", "2201",
    "-r",
    "/local/project/dist/app.tgz",
    "deploy@devbox:/srv/releases/app.tgz",
  ]);
  assert.equal(invocation.env.SSHPASS, "not-in-arguments");
  assert.equal(invocation.args.includes("not-in-arguments"), false);
});

test("scp brackets IPv6 hosts in remote operands", () => {
  const invocation = buildScpInvocation({
    action: "download",
    server: { ...server, target: "deploy@2001:db8::20", port: undefined, authenticationPreference: "auto", identityFile: undefined, configFile: undefined },
    localPath: "/local/project/artifact.bin",
    remotePath: "/srv/artifact.bin",
    knownHostsFile: "/local/pi-agent/ssh/known_hosts",
    platform: "linux",
  });
  assert.deepEqual(invocation.args.slice(-2), ["deploy@[2001:db8::20]:/srv/artifact.bin", "/local/project/artifact.bin"]);
});

test("scp process runner returns failures and enforces cancellation and timeout", async () => {
  const failed = await runScpProcess({ executable: process.execPath, args: ["-e", "process.stderr.write('denied');process.exit(7)"], env: process.env }, { timeoutSeconds: 5 });
  assert.equal(failed.exitCode, 7);
  assert.equal(failed.stderr.toString(), "denied");

  const controller = new AbortController();
  const cancelled = runScpProcess({ executable: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], env: process.env }, { timeoutSeconds: 5, signal: controller.signal });
  controller.abort(new Error("cancelled by test"));
  await assert.rejects(cancelled, /cancelled by test/);

  await assert.rejects(runScpProcess({ executable: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], env: process.env }, { timeoutSeconds: 0.01 }), /超时/);
});

test("scp cancellation terminates wrapper descendants", { skip: process.platform !== "linux" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "ssh-scp-process-tree-"));
  const pidFile = join(root, "child.pid");
  const wrapper = [
    "const {spawn}=require('node:child_process');",
    `const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});`,
    `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(child.pid));`,
    "setInterval(()=>{},1000);",
  ].join("");
  const controller = new AbortController();
  let childPid = 0;
  try {
    const running = runScpProcess({ executable: process.execPath, args: ["-e", wrapper], env: process.env }, { timeoutSeconds: 5, signal: controller.signal });
    for (let attempt = 0; attempt < 100 && !existsSync(pidFile); attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(existsSync(pidFile), true);
    childPid = Number(readFileSync(pidFile, "utf8"));
    controller.abort(new Error("stop tree"));
    await assert.rejects(running, /stop tree/);
    let alive = true;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        process.kill(childPid, 0);
        if (readFileSync(`/proc/${childPid}/stat`, "utf8").split(" ")[2] === "Z") { alive = false; break; }
      } catch { alive = false; break; }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(alive, false);
  } finally {
    if (childPid) try { process.kill(childPid, "SIGKILL"); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});

test("ssh_scp is active only for trusted local projects and delegates transfers", async () => {
  let active = ["read"];
  const tools = new Map<string, any>();
  const pi = {
    registerTool: (tool: any) => tools.set(tool.name, tool),
    getActiveTools: () => [...active],
    setActiveTools: (value: string[]) => { active = value; },
  } as any;
  const request = { action: "download", local_path: "artifacts/app.tgz", remote_path: "/srv/app.tgz" } as const;
  let received: unknown;
  registerRemoteExecutionTools(pi, {
    controller: {} as any,
    scp: { execute: async (value: unknown) => { received = value; return { content: [{ type: "text", text: "ok" }], details: {} }; } } as any,
    servers: { list: () => [server] } as any,
    mappings: {} as any,
    getMirrorQueue: () => undefined,
    isFullRemoteWorkspace: () => false,
  });
  assert.ok(tools.has("ssh_scp"));
  await tools.get("ssh_scp").execute("id", request, undefined, undefined, {});
  assert.deepEqual(received, request);

  syncRemoteExecutionActiveTools(pi, { enabled: true, trusted: true, fullRemote: false, hasServers: true, hasMapping: false });
  assert.ok(active.includes("ssh_scp"));
  syncRemoteExecutionActiveTools(pi, { enabled: true, trusted: false, fullRemote: false, hasServers: true, hasMapping: false });
  assert.equal(active.includes("ssh_scp"), false);
  syncRemoteExecutionActiveTools(pi, { enabled: true, trusted: true, fullRemote: true, hasServers: true, hasMapping: false });
  assert.equal(active.includes("ssh_scp"), false);
});

test("scp controller confines local paths to a trusted project and preflights the server", async () => {
  const root = mkdtempSync(join(tmpdir(), "ssh-scp-project-"));
  const outside = mkdtempSync(join(tmpdir(), "ssh-scp-outside-"));
  mkdirSync(join(root, "dist"));
  mkdirSync(join(root, "bundle"));
  writeFileSync(join(root, "dist", "app.tgz"), "archive");
  symlinkSync(outside, join(root, "escape"));
  symlinkSync(outside, join(root, "bundle", "outside"));
  let leases = 0;
  let releases = 0;
  const calls: unknown[] = [];
  const controller = new ScpController({
    servers: { list: () => [server], findByName: (name: string) => name === server.name ? server : undefined, get: () => server } as any,
    mappings: { find: () => undefined } as any,
    connections: {
      acquire: async () => { leases++; return { release: async () => { releases++; } }; },
      cachedPassword: async () => undefined,
    } as any,
    getDefaultServerId: () => undefined,
    knownHostsFile: "/local/pi-agent/ssh/known_hosts",
    run: async (invocation) => { calls.push(invocation); return { exitCode: 0, stderr: Buffer.alloc(0) }; },
    platform: "linux",
  });
  const ctx = { cwd: root, isProjectTrusted: () => true } as any;
  try {
    const result = await controller.execute({ action: "upload", local_path: "dist/app.tgz", remote_path: "/srv/app.tgz" }, ctx);
    assert.match((result.content[0] as any).text, /上传完成/);
    assert.equal(leases, 1);
    assert.equal(releases, 1);
    assert.equal(calls.length, 1);
    await assert.rejects(controller.execute({ action: "download", local_path: "escape/file", remote_path: "/srv/file" }, ctx), /项目目录之外/);
    await assert.rejects(controller.execute({ action: "upload", local_path: "bundle", remote_path: "/srv/bundle", recursive: true }, ctx), /符号链接.*项目目录之外/);
    await assert.rejects(controller.execute({ action: "upload", local_path: "dist/app.tgz", remote_path: "/srv/file; touch /tmp/pwned" }, ctx), /远端路径.*安全字符/);
    await assert.rejects(controller.execute({ action: "upload", local_path: "missing", remote_path: "/srv/file" }, ctx), /不存在/);
    await assert.rejects(controller.execute({ action: "upload", local_path: "dist/app.tgz", remote_path: "/srv/file" }, { ...ctx, isProjectTrusted: () => false }), /不受信任/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
