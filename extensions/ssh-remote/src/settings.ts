import { registerExtensionSettings } from "@aoliyougei/pi-shared-settings";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  SSH_REMOTE_SETTINGS_NAMESPACE,
  type SshRemoteConfig,
} from "./config.ts";
import type { SshTransportPreference } from "./transport/client.ts";

const TRANSPORT_LABELS: Record<SshTransportPreference, string> = {
  auto: "auto（自动）",
  openssh: "openssh（系统 OpenSSH）",
  ssh2: "ssh2（内置连接）",
};

interface SshRemoteSettingsController {
  getConfig(): SshRemoteConfig;
  updateConfig(config: SshRemoteConfig, ctx: ExtensionContext): void;
}

function transportForLabel(value: string): SshTransportPreference | undefined {
  return (Object.entries(TRANSPORT_LABELS) as Array<[SshTransportPreference, string]>)
    .find(([, label]) => label === value)?.[0];
}

function booleanForLabel(value: string): boolean | undefined {
  if (value === "开启") return true;
  if (value === "关闭") return false;
  return undefined;
}

function booleanLabel(value: boolean): string {
  return value ? "开启" : "关闭";
}

export function registerSshRemoteSettings(
  pi: ExtensionAPI,
  controller: SshRemoteSettingsController,
): void {
  registerExtensionSettings(pi, {
    namespace: SSH_REMOTE_SETTINGS_NAMESPACE,
    title: "SSH Remote（SSH 远程）",
    settings: () => [{
      id: "transport",
      label: "传输方式",
      description: "auto 在 Unix 使用复用的 OpenSSH，在 Windows 使用持久 ssh2 连接",
      currentValue: TRANSPORT_LABELS[controller.getConfig().transport],
      values: Object.values(TRANSPORT_LABELS),
    }, {
      id: "passwordPrompt",
      label: "密码提示",
      description: "密钥或 Agent 认证失败时在界面中询问 SSH 密码",
      currentValue: booleanLabel(controller.getConfig().passwordPrompt),
      values: ["开启", "关闭"],
    }, {
      id: "persistPasswords",
      label: "持久化密码",
      description: "将输入的密码保存到受限 secrets 文件，使 -r 恢复时无需再次询问",
      currentValue: booleanLabel(controller.getConfig().persistPasswords),
      values: ["开启", "关闭"],
    }, {
      id: "aiControlTools",
      label: "AI 控制工具",
      description: "允许模型连接、退出、检查 SSH 环境并修改 cwd",
      currentValue: booleanLabel(controller.getConfig().aiControlTools),
      values: ["开启", "关闭"],
    }, {
      id: "aiPasswordAuth",
      label: "AI 密码认证",
      description: "模型触发的 SSH 连接在密钥认证失败时可请求密码",
      currentValue: booleanLabel(controller.getConfig().aiPasswordAuth),
      values: ["开启", "关闭"],
    }, {
      id: "remoteExecutionTools",
      label: "远程执行工具",
      description: "存在已保存服务器和项目映射时启用 ssh_exec、ssh_scp、ssh_sync 和 ssh_list_servers",
      currentValue: booleanLabel(controller.getConfig().remoteExecutionTools),
      values: ["开启", "关闭"],
    }, {
      id: "execConfirmation",
      label: "远程命令确认",
      description: "选择永不确认、仅破坏性命令确认或每次 ssh_exec 都确认",
      currentValue: controller.getConfig().execConfirmation === "never" ? "永不" : controller.getConfig().execConfirmation === "always" ? "每次" : "破坏性命令",
      values: ["永不", "破坏性命令", "每次"],
    }],
    onChange: (id, value, ctx) => {
      const config = controller.getConfig();
      if (id === "transport") {
        const transport = transportForLabel(value);
        if (transport) controller.updateConfig({ ...config, transport }, ctx);
        return;
      }
      if (id === "execConfirmation") {
        const policy = value === "永不" ? "never" : value === "每次" ? "always" : value === "破坏性命令" ? "destructive" : undefined;
        if (policy) controller.updateConfig({ ...config, execConfirmation: policy }, ctx);
        return;
      }
      if (
        id === "passwordPrompt"
        || id === "persistPasswords"
        || id === "aiControlTools"
        || id === "aiPasswordAuth"
        || id === "remoteExecutionTools"
      ) {
        const enabled = booleanForLabel(value);
        if (enabled !== undefined) controller.updateConfig({ ...config, [id]: enabled }, ctx);
      }
    },
  });
}

export { TRANSPORT_LABELS };
