import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { trustHostKey } from "./store.ts";
import { UnknownSshHostKeyError, type SshHostKeyCandidate } from "./types.ts";

export interface SshHostTrustControllerOptions {
  path: string;
  maxConfirmations?: number;
}

export class SshHostTrustController {
  private readonly path: string;
  private readonly maxConfirmations: number;
  private readonly decisions = new Map<string, Promise<boolean>>();

  constructor(options: SshHostTrustControllerOptions) {
    this.path = options.path;
    this.maxConfirmations = options.maxConfirmations ?? 17;
  }

  private candidateKey(candidate: SshHostKeyCandidate): string {
    return `${candidate.lookupHost}\0${candidate.fingerprint}`;
  }

  private confirm(ctx: ExtensionContext, candidate: SshHostKeyCandidate): Promise<boolean> {
    const key = this.candidateKey(candidate);
    const current = this.decisions.get(key);
    if (current) return current;
    const decision = (async () => {
      const confirmed = await ctx.ui.confirm(
        "确认 SSH 主机指纹",
        `目标：${candidate.lookupHost}\n密钥类型：${candidate.keyType}\nSHA-256 指纹：${candidate.fingerprint}\n\n这是首次连接该主机。请通过可信渠道核对指纹。\n是否信任并保存？`,
      );
      if (confirmed) {
        trustHostKey(candidate, this.path);
        ctx.ui.notify(`已保存 SSH 主机指纹：${candidate.lookupHost}`, "info");
      }
      return confirmed;
    })();
    this.decisions.set(key, decision);
    void decision.finally(() => {
      if (this.decisions.get(key) === decision) this.decisions.delete(key);
    }).catch(() => {});
    return decision;
  }

  async connectWithTrust<T>(ctx: ExtensionContext, attempt: () => Promise<T>): Promise<T> {
    const seen = new Set<string>();
    for (let confirmations = 0; ; confirmations++) {
      try {
        return await attempt();
      } catch (error) {
        if (!(error instanceof UnknownSshHostKeyError)) throw error;
        if (!ctx.hasUI) throw new Error(`未知 SSH 主机 ${error.candidate.lookupHost} 需要交互式界面确认指纹`, { cause: error });
        const key = this.candidateKey(error.candidate);
        if (seen.has(key)) throw new Error(`SSH 主机指纹确认后重复出现未知候选：${error.candidate.lookupHost}`, { cause: error });
        if (confirmations >= this.maxConfirmations) throw new Error(`SSH 主机指纹确认超过 ${this.maxConfirmations} 个节点`, { cause: error });
        seen.add(key);
        if (!await this.confirm(ctx, error.candidate)) {
          throw new Error(`SSH 主机指纹未信任：${error.candidate.lookupHost}`, { cause: error });
        }
      }
    }
  }
}
