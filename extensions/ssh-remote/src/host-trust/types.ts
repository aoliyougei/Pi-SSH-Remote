export type SshHostRole = "target" | "jump";

export interface SshHostKeyEndpoint {
  host: string;
  port: number;
  hostKeyAlias?: string;
  role: SshHostRole;
}

export interface SshHostKeyCandidate extends SshHostKeyEndpoint {
  lookupHost: string;
  keyType: string;
  keyBase64: string;
  fingerprint: string;
}

export class UnknownSshHostKeyError extends Error {
  constructor(readonly candidate: SshHostKeyCandidate) {
    super(`未知 SSH 主机指纹：${candidate.lookupHost}（${candidate.fingerprint}）`);
    this.name = "UnknownSshHostKeyError";
  }
}

export class ChangedSshHostKeyError extends Error {
  constructor(readonly candidate: SshHostKeyCandidate, reason = "SSH 主机指纹与 known_hosts 不匹配") {
    super(`${reason}：${candidate.lookupHost}（${candidate.fingerprint}）`);
    this.name = "ChangedSshHostKeyError";
  }
}
