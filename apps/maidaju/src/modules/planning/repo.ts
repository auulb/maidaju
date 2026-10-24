// 候选持久化端口。正式实现由 AI-3 的 Prisma 层提供；内存实现仅用于测试/本地开发。
import type { Candidate } from "./types";

export interface CandidateRepository {
  /** 版本不可原地覆盖：同一 id+version 已存在时返回 false */
  insert(c: Candidate): Promise<boolean>;
  get(id: string, version: number): Promise<Candidate | null>;
  latest(id: string): Promise<Candidate | null>;
  listBySession(sessionId: string): Promise<Candidate[]>;
  /** 仅允许修改 status/staleReason（版本内容不可变） */
  setStatus(id: string, version: number, status: Candidate["status"], reason: string | null): Promise<void>;
}

export class MemoryCandidateRepository implements CandidateRepository {
  rows = new Map<string, Candidate>();
  private key = (id: string, v: number) => `${id}@${v}`;

  async insert(c: Candidate) {
    const k = this.key(c.id, c.version);
    if (this.rows.has(k)) return false;
    this.rows.set(k, structuredClone(c));
    return true;
  }
  async get(id: string, version: number) {
    const c = this.rows.get(this.key(id, version));
    return c ? structuredClone(c) : null;
  }
  async latest(id: string) {
    let best: Candidate | null = null;
    for (const c of this.rows.values()) if (c.id === id && (!best || c.version > best.version)) best = c;
    return best ? structuredClone(best) : null;
  }
  async listBySession(sessionId: string) {
    return [...this.rows.values()].filter((c) => c.sessionId === sessionId).map((c) => structuredClone(c));
  }
  async setStatus(id: string, version: number, status: Candidate["status"], reason: string | null) {
    const c = this.rows.get(this.key(id, version));
    if (c) {
      c.status = status;
      c.staleReason = reason;
    }
  }
}
