import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../extensions/ssh-remote/src/", import.meta.url);

function source(path: string): string {
  return readFileSync(new URL(path, root), "utf8");
}

test("SSH Remote user-facing dialogs and settings are Chinese while technical IDs stay stable", () => {
  const commands = source("servers/commands.ts");
  const settings = source("settings.ts");
  const extension = source("extension.ts");
  const tools = source("exec/tools.ts");
  const resources = source("resources/controller.ts");

  for (const text of ["服务器管理", "选择 SSH 服务器", "删除 SSH 服务器", "远端镜像目录"]) assert.match(commands, new RegExp(text));
  for (const text of ["传输方式", "密码提示", "持久化密码", "远程执行工具"]) assert.match(settings, new RegExp(text));
  for (const text of ["SSH 连接失败", "本地工作区"]) assert.match(extension, new RegExp(text));
  assert.match(resources, /远端项目资源/);
  assert.match(tools, /已保存的 SSH 服务器/);
  assert.match(tools, /name: "ssh_exec"/);
  assert.match(tools, /name: "ssh_scp"/);
  assert.match(extension, /registerCommand\("ssh-connect"/);
});
