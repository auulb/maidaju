// checkout 持久化端口 + 内存实现（测试/本地）。生产实现须保证同样的原子语义。
import type { Order, OrderAttempt, OrderAuthorization, Quote } from "@/contracts";

export interface CheckoutRepository {
  saveQuote(q: Quote): Promise<void>;
  getQuote(id: string): Promise<Quote | null>;
  /** 使某局/某候选所有 verified 报价失效，并作废其未消费授权 */
  invalidateForSession(sessionId: string, candidateId?: string): Promise<number>;

  saveAuthorization(a: OrderAuthorization): Promise<void>;
  getAuthorization(id: string): Promise<OrderAuthorization | null>;

  /**
   * 原子操作：若该授权无尝试记录则插入并返回 {created:true}；
   * 已存在则返回既有记录 {created:false}。对应 authorizationId 唯一约束。
   */
  claimAttempt(a: OrderAttempt): Promise<{ created: boolean; attempt: OrderAttempt }>;
  getAttemptByAuthorization(authorizationId: string): Promise<OrderAttempt | null>;
  listAttempts(statuses: OrderAttempt["status"][]): Promise<OrderAttempt[]>;
  updateAttempt(id: string, patch: Partial<OrderAttempt>): Promise<OrderAttempt>;
  markAuthorizationConsumed(id: string, at: string): Promise<void>;

  saveOrder(o: Order): Promise<void>;
  getOrder(orderId: string): Promise<Order | null>;
}

export class MemoryCheckoutRepo implements CheckoutRepository {
  quotes = new Map<string, Quote>();
  auths = new Map<string, OrderAuthorization>();
  attempts = new Map<string, OrderAttempt>(); // key: authorizationId
  orders = new Map<string, Order>();

  async saveQuote(q: Quote) { this.quotes.set(q.id, structuredClone(q)); }
  async getQuote(id: string) { return structuredClone(this.quotes.get(id) ?? null); }

  async invalidateForSession(sessionId: string, candidateId?: string) {
    let n = 0;
    const now = new Date().toISOString();
    for (const q of this.quotes.values()) {
      if (q.sessionId !== sessionId || (candidateId && q.candidateId !== candidateId) || q.status !== "verified") continue;
      q.status = "stale";
      n++;
      for (const a of this.auths.values()) if (a.quoteId === q.id && !a.consumedAt && !a.invalidatedAt) a.invalidatedAt = now;
    }
    return n;
  }

  async saveAuthorization(a: OrderAuthorization) { this.auths.set(a.id, structuredClone(a)); }
  async getAuthorization(id: string) { return structuredClone(this.auths.get(id) ?? null); }

  async claimAttempt(a: OrderAttempt) {
    const existing = this.attempts.get(a.authorizationId); // 同步检查+插入，单线程下原子
    if (existing) return { created: false, attempt: structuredClone(existing) };
    this.attempts.set(a.authorizationId, structuredClone(a));
    return { created: true, attempt: structuredClone(a) };
  }

  async listAttempts(statuses: OrderAttempt["status"][]) {
    return [...this.attempts.values()].filter((a) => statuses.includes(a.status)).map((a) => structuredClone(a));
  }

  async getAttemptByAuthorization(authorizationId: string) {
    return structuredClone(this.attempts.get(authorizationId) ?? null);
  }

  async updateAttempt(id: string, patch: Partial<OrderAttempt>) {
    const cur = [...this.attempts.values()].find((x) => x.id === id);
    if (!cur) throw new Error(`attempt ${id} 不存在`);
    Object.assign(cur, patch);
    return structuredClone(cur);
  }

  async markAuthorizationConsumed(id: string, at: string) {
    const a = this.auths.get(id);
    if (a) a.consumedAt = at;
  }

  async saveOrder(o: Order) { this.orders.set(o.orderId, structuredClone(o)); }
  async getOrder(id: string) { return structuredClone(this.orders.get(id) ?? null); }
}
