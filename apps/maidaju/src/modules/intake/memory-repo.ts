// 仅用于测试与本地开发的内存实现；正式持久化由 AI-3 的 Prisma repository 提供。
import type { DiningSessionRecord, IntakeRepository } from "../ports";
import type { MemberRequirement } from "./types";
import type { Fact, MenuSnapshot, StoreSummary } from "../catalog/types";

export class MemoryIntakeRepository implements IntakeRepository {
  sessions = new Map<string, DiningSessionRecord>();
  members = new Map<string, MemberRequirement[]>();
  stores = new Map<string, StoreSummary[]>();
  menus = new Map<string, MenuSnapshot | null>();
  facts = new Map<string, Fact[]>();

  async getSession(id: string) {
    const s = this.sessions.get(id);
    return s ? structuredClone(s) : null;
  }
  async saveSession(next: DiningSessionRecord, expectedRevision: number | null) {
    const cur = this.sessions.get(next.id);
    if (expectedRevision === null ? cur : cur?.revision !== expectedRevision) return null;
    this.sessions.set(next.id, structuredClone(next));
    return structuredClone(next);
  }
  async getMembers(id: string) {
    return structuredClone(this.members.get(id) ?? []);
  }
  async replaceMembers(id: string, m: MemberRequirement[]) {
    this.members.set(id, structuredClone(m));
  }
  async getStoreSearch(id: string) {
    return structuredClone(this.stores.get(id) ?? []);
  }
  async saveStoreSearch(id: string, s: StoreSummary[]) {
    this.stores.set(id, structuredClone(s));
  }
  async getMenuSnapshot(id: string) {
    return structuredClone(this.menus.get(id) ?? null);
  }
  async saveMenuSnapshot(id: string, s: MenuSnapshot | null) {
    this.menus.set(id, structuredClone(s));
  }
  async getFactConfirmations(id: string) {
    return structuredClone(this.facts.get(id) ?? []);
  }
  async replaceFactConfirmations(id: string, f: Fact[]) {
    this.facts.set(id, structuredClone(f));
  }
}
