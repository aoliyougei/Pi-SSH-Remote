import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { LocalProjectMapping } from "../mappings/types.ts";
import type { MappingController } from "../mappings/controller.ts";
import type { MirrorQueue } from "../sync/queue.ts";
import type { ServerController } from "../servers/controller.ts";
import type { RemoteExecController } from "./controller.ts";

const TOOL_NAMES = new Set(["ssh_list_servers", "ssh_exec", "ssh_sync"]);
export interface RemoteExecutionToolState { enabled: boolean; trusted: boolean; fullRemote: boolean; hasServers: boolean; hasMapping: boolean }

export function syncRemoteExecutionActiveTools(pi: ExtensionAPI, state: RemoteExecutionToolState): void {
  const base = pi.getActiveTools().filter((name) => !TOOL_NAMES.has(name));
  const next = [...base];
  if (state.enabled && state.hasServers) next.push("ssh_list_servers", "ssh_exec");
  if (state.enabled && state.hasMapping && state.trusted && !state.fullRemote) next.push("ssh_sync");
  const current = pi.getActiveTools();
  if (current.length !== next.length || current.some((value, index) => value !== next[index])) pi.setActiveTools(next);
}

export interface RemoteExecutionToolDependencies {
  controller: RemoteExecController;
  servers: ServerController;
  mappings: MappingController;
  getMirrorQueue(mapping: LocalProjectMapping): MirrorQueue | undefined;
  isFullRemoteWorkspace(): boolean;
}

export function registerRemoteExecutionTools(pi: ExtensionAPI, dependencies: RemoteExecutionToolDependencies): void {
  pi.registerTool({
    name: "ssh_list_servers", label: "SSH 服务器",
    description: "列出可用于独立远程执行且不改变当前工作区的已保存 SSH 服务器。",
    promptSnippet: "目标不明确时列出已保存的远程执行服务器",
    promptGuidelines: ["仅在远程执行目标不明确时使用 ssh_list_servers；已映射的本地项目已有默认服务器。"],
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const mapping = dependencies.isFullRemoteWorkspace() ? undefined : dependencies.mappings.find(ctx.cwd);
      const lines = ["已保存的 SSH 服务器："];
      for (const server of dependencies.servers.list()) lines.push("", server.name, ...(server.description ? [`  描述：${server.description}`] : []), `  目标：${server.target}${server.port ? `:${server.port}` : ""}`, `  Shell：${server.shellPreference}`, `  传输方式：${server.transportPreference}`, `  已映射项目：${dependencies.mappings.list().filter((item) => item.serverId === server.id).length}`);
      if (mapping) {
        const server = dependencies.servers.get(mapping.serverId);
        lines.push("", "当前项目镜像：", `  服务器：${server?.name ?? "缺失"}`, `  远端 cwd：${mapping.remoteRoot}`, `  状态：${dependencies.getMirrorQueue(mapping)?.status.state ?? "不可用"}`);
      }
      return { content: [{ type: "text", text: dependencies.servers.list().length ? lines.join("\n") : "没有已保存的 SSH 服务器，请使用 /ssh add。" }], details: { count: dependencies.servers.list().length } };
    },
  });
  pi.registerTool({
    name: "ssh_exec", label: "SSH 远程执行",
    description: "在已保存的 SSH 服务器上执行命令，不改变 Pi 的本地或完整远程工作区模式。",
    promptSnippet: "在已保存的远程服务器上运行构建、测试、服务和诊断",
    promptGuidelines: [
      "本地项目配置镜像后，应主动使用 ssh_exec 执行构建、测试、运行和远程诊断，不必等待用户提醒。",
      "继续使用本地文件工具读取和修改代码；ssh_exec 不会切换工作区。",
      "仅对不依赖最新代码的诊断使用 require_synced=false，禁止用它测试或启动陈旧代码。",
    ],
    parameters: Type.Object({ server: Type.Optional(Type.String()), command: Type.String({ minLength: 1 }), cwd: Type.Optional(Type.String()), timeout: Type.Optional(Type.Number({ minimum: 1, maximum: 86_400 })), require_synced: Type.Optional(Type.Boolean()) }),
    async execute(_id, params, signal, onUpdate, ctx) { return dependencies.controller.execute(params, ctx, signal, onUpdate); },
  });
  pi.registerTool({
    name: "ssh_sync", label: "SSH 同步",
    description: "强制严格同步并完整验证当前受信任本地项目的远端镜像。",
    promptSnippet: "强制或恢复当前本地项目镜像同步",
    promptGuidelines: ["自动同步失败、已暂停或用户明确要求立即完整验证时使用 ssh_sync；不要在完整 SSH 工作区中使用。"],
    parameters: Type.Object({ force: Type.Optional(Type.Boolean()) }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (dependencies.isFullRemoteWorkspace()) throw new Error("完整 SSH 工作区中不能使用 ssh_sync，因为文件工具已经直接操作远端");
      if (!ctx.isProjectTrusted()) throw new Error("当前项目不受信任，已禁用同步");
      const mapping = dependencies.mappings.find(ctx.cwd);
      if (!mapping) throw new Error("当前本地项目未配置远端镜像，请使用 /ssh map add。");
      const queue = dependencies.getMirrorQueue(mapping);
      if (!queue) throw new Error("当前项目镜像不可用");
      await queue.requestSync({ reason: "tool", immediate: true, force: params.force });
      await queue.waitUntilSettled(signal);
      const audit = queue.auditRecords.at(-1);
      return { content: [{ type: "text", text: `镜像同步完成\n服务器映射：${mapping.serverId}\n远端：${mapping.remoteRoot}\n代次：${queue.status.syncedGeneration}\n已上传：${audit?.uploaded.length ?? 0}\n已删除：${audit?.deleted.length ?? 0}\n已验证：${audit?.verifiedFiles ?? 0}\n结果：完全一致` }], details: { mappingId: mapping.id, state: queue.status.state, generation: queue.status.syncedGeneration } };
    },
  });
}
