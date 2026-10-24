// AI-3 核价 / 确认闸门 / 下单 / 订单状态。
// 规则：价格只来自 calculate-price；订单只来自 create-order；授权只来自用户明确操作。
import { randomUUID } from "@/lib/ids";
import type { CheckoutSnapshot, Order, OrderAttempt, OrderAuthorization, Quote } from "@/contracts";
import { AppError } from "@/server/errors";
import { McpNotSentError, McpOutcomeUnknownError, type ToolRegistry } from "@/server/mcp/transport";
import { allocateMembers, checkBudgets } from "./allocation";
import { normalizeCreatedOrder, normalizeOrderStatus, normalizePrice } from "./normalize";
import { assertModeConsistent, buildCreateOrderArgs, buildPriceArgs, canonicalJson, cartHash, confirmDigest, parseSnapshot, sha256 } from "./params";
import type { CheckoutRepository } from "./repo";

/** 由 AI-2 提供：按 id+version 读取当前候选快照（不存在或已被替代返回 null） */
export type SnapshotSource = {
  getCheckoutSnapshot(candidateId: string, version: number): Promise<CheckoutSnapshot | null>;
  /** 当前最新版本，用于检测候选已被修改 */
  getLatestVersion(candidateId: string): Promise<number | null>;
};

export type CheckoutDeps = {
  repo: CheckoutRepository;
  tools: ToolRegistry;
  snapshots: SnapshotSource;
  now?: () => Date;
  quoteWindowMs?: number; // 本地安全窗口，默认 3 分钟；不代表服务端锁价
};

const WINDOW = 3 * 60_000;

export class CheckoutService {
  private now: () => Date;
  private window: number;
  constructor(private d: CheckoutDeps) {
    this.now = d.now ?? (() => new Date());
    this.window = d.quoteWindowMs ?? WINDOW;
  }

  private async loadSnapshot(candidateId: string, version: number): Promise<CheckoutSnapshot> {
    const latest = await this.d.snapshots.getLatestVersion(candidateId);
    if (latest !== version) throw new AppError("STALE_REVISION", "候选已被修改，请重新核价", false, { latest });
    const raw = await this.d.snapshots.getCheckoutSnapshot(candidateId, version);
    if (!raw) throw new AppError("STALE_REVISION", "候选版本不存在");
    const s = parseSnapshot(raw);
    assertModeConsistent(s, this.d.tools.mode);
    return s;
  }

  // ---------- 核价 ----------
  async quote(candidateId: string, version: number): Promise<Quote> {
    const s = await this.loadSnapshot(candidateId, version);
    if (s.hardConstraintStatus === "fail") throw new AppError("CONSTRAINT_FAILED", "候选存在明确冲突，不能核价下单");
    const args = buildPriceArgs(s);
    const hash = cartHash(s);
    const checkedAt = this.now();

    let res;
    try {
      res = await this.d.tools.call("calculatePrice", args);
    } catch (e) {
      throw new AppError("MCP_ERROR", `核价请求失败：${(e as Error).message}`, true); // 只读，可重试
    }
    const base = {
      id: randomUUID(), sessionId: s.sessionId, candidateId, candidateVersion: version,
      sessionRevision: s.sessionRevision, mode: s.mode, cartHash: hash,
      checkedAt: checkedAt.toISOString(), expiresAt: new Date(checkedAt.getTime() + this.window).toISOString(),
      sourceRef: `calculate-price@${checkedAt.toISOString()}#${sha256(canonicalJson(res.raw ?? null)).slice(0, 12)}`,
    };
    const failed = (msg: string): never => {
      void this.d.repo.saveQuote({ ...base, status: "failed", payableFen: 0, originalFen: null, lineAmountsFen: null, memberAllocatedFen: null, allocationNote: msg, budgetOk: "pending", takeWayOptions: [] });
      throw new AppError("MCP_ERROR", msg, true);
    };
    if (!res.ok) return failed(`服务端拒绝核价：${res.message}`);
    const p = normalizePrice(res.data, s.items.map((i) => i.productCode));
    if ("error" in p) return failed(p.error);

    const lineAmounts = p.lineAmountsFen ? Object.fromEntries(s.items.map((i, k) => [i.lineId, p.lineAmountsFen![k]!])) : null;
    const allocated = allocateMembers(s, lineAmounts, p.payableFen);
    const budget = checkBudgets(s, p.payableFen, allocated);

    const q: Quote = {
      ...base, status: "verified", payableFen: p.payableFen, originalFen: p.originalFen,
      lineAmountsFen: lineAmounts, memberAllocatedFen: allocated,
      allocationNote: allocated
        ? "本局记账分摊（按服务端行金额比例分配实付，尾差按成员顺序），不代表服务端逐人收费"
        : "服务端未返回足以分配的行金额，需组织者确认分摊表",
      budgetOk: budget.status, takeWayOptions: p.takeWayOptions,
    };
    await this.d.repo.saveQuote(q);
    return q;
  }

  // ---------- 确认闸门 ----------
  async authorize(input: {
    quoteId: string;
    takeWayCode: string;
    acknowledgedFactIds: string[];
    organizerId: string;
    userConfirmed: boolean; // 必须来自用户点击“确认创建订单”
  }): Promise<OrderAuthorization> {
    if (input.userConfirmed !== true) throw new AppError("NEEDS_USER_INPUT", "需要用户明确确认创建订单");
    const q = await this.d.repo.getQuote(input.quoteId);
    if (!q || q.status !== "verified") throw new AppError("QUOTE_STALE", "报价已失效，请重新核价");
    if (this.now().getTime() > Date.parse(q.expiresAt)) throw new AppError("QUOTE_STALE", "报价超出本地安全窗口，请重新核价", true);
    const s = await this.loadSnapshot(q.candidateId, q.candidateVersion);
    this.assertQuoteMatches(q, s);
    this.assertGates(q, s, input.acknowledgedFactIds);
    if (!q.takeWayOptions.some((t) => t.code === input.takeWayCode)) {
      throw new AppError("NEEDS_USER_INPUT", "取餐方式不在最新核价返回的列表中", false, { options: q.takeWayOptions });
    }
    const a: OrderAuthorization = {
      id: randomUUID(), quoteId: q.id, cartHash: q.cartHash,
      confirmDigest: confirmDigest(s, input.takeWayCode, input.acknowledgedFactIds),
      takeWayCode: input.takeWayCode, acknowledgedFactIds: [...input.acknowledgedFactIds],
      organizerId: input.organizerId, confirmedAt: this.now().toISOString(), consumedAt: null, invalidatedAt: null,
    };
    await this.d.repo.saveAuthorization(a);
    return a;
  }

  private assertQuoteMatches(q: Quote, s: CheckoutSnapshot) {
    if (cartHash(s) !== q.cartHash || s.sessionRevision !== q.sessionRevision) {
      throw new AppError("QUOTE_STALE", "订单内容或需求已变更，请重新核价");
    }
  }

  private assertGates(q: Quote, s: CheckoutSnapshot, ack: string[]) {
    if (s.hardConstraintStatus === "fail") throw new AppError("CONSTRAINT_FAILED", "候选存在明确冲突");
    const unacked = s.unresolvedFactIds.filter((f) => !ack.includes(f));
    if (unacked.length) throw new AppError("FACT_PENDING", "存在未确认事实，需逐项接受后继续", false, { factIds: unacked });
    if (q.budgetOk === "fail") throw new AppError("BUDGET_EXCEEDED", "实付或个人分摊超出预算");
    if (q.budgetOk === "pending") throw new AppError("NEEDS_USER_INPUT", "个人预算待确认：需组织者确认分摊表");
  }

  // ---------- 下单 ----------
  async createOrder(authorizationId: string, idempotencyKey: string): Promise<{ attempt: OrderAttempt; order: Order | null }> {
    const auth = await this.d.repo.getAuthorization(authorizationId);
    if (!auth) throw new AppError("AUTH_INVALID", "授权不存在");

    // 已有尝试：复用，不再发远程请求（双击 / 重放）
    const prior = await this.existingAttempt(auth);
    if (prior) return prior;

    if (auth.invalidatedAt) throw new AppError("AUTH_INVALID", "授权已失效，请重新确认");
    if (auth.consumedAt) throw new AppError("AUTH_INVALID", "授权已使用");
    const q = await this.d.repo.getQuote(auth.quoteId);
    if (!q || q.status !== "verified") throw new AppError("QUOTE_STALE", "报价已失效，请返回确认页重新核价");
    if (this.now().getTime() > Date.parse(q.expiresAt)) throw new AppError("QUOTE_STALE", "报价已过期，请返回确认页重新核价", true);
    const s = await this.loadSnapshot(q.candidateId, q.candidateVersion);
    this.assertQuoteMatches(q, s);
    if (confirmDigest(s, auth.takeWayCode, auth.acknowledgedFactIds) !== auth.confirmDigest) {
      throw new AppError("AUTH_INVALID", "确认后内容已变化，请重新确认");
    }
    this.assertGates(q, s, auth.acknowledgedFactIds);

    const args = buildCreateOrderArgs(s, auth.takeWayCode);
    const ts = this.now().toISOString();
    const claim = await this.d.repo.claimAttempt({
      id: randomUUID(), authorizationId, idempotencyKey, requestDigest: sha256(canonicalJson(args)),
      status: "prepared", orderId: null, error: null, createdAt: ts, updatedAt: ts,
    });
    if (!claim.created) {
      // 并发竞争失败：另一请求已占用该授权，不再发送
      const r = await this.existingAttempt(auth);
      return r ?? { attempt: claim.attempt, order: null };
    }

    // 发送前先持久化 sending；进程中断后由 recoverStuckAttempts 标记为结果未知
    let attempt = await this.d.repo.updateAttempt(claim.attempt.id, { status: "sending", updatedAt: this.now().toISOString() });
    await this.d.repo.markAuthorizationConsumed(authorizationId, this.now().toISOString());

    let res;
    try {
      res = await this.d.tools.call("createOrder", args, { timeoutMs: 30_000 }); // 不自动重试
    } catch (e) {
      if (e instanceof McpNotSentError) {
        attempt = await this.d.repo.updateAttempt(attempt.id, { status: "rejected", error: "请求未发出", updatedAt: this.now().toISOString() });
        return { attempt, order: null };
      }
      attempt = await this.d.repo.updateAttempt(attempt.id, {
        status: "outcome_unknown",
        error: e instanceof McpOutcomeUnknownError ? e.message : "未知错误",
        updatedAt: this.now().toISOString(),
      });
      throw new AppError("ORDER_OUTCOME_UNKNOWN", "订单创建结果不明，已冻结再次下单。请在麦当劳 APP 查看订单后再处理", false, { attemptId: attempt.id });
    }

    if (!res.ok) {
      attempt = await this.d.repo.updateAttempt(attempt.id, { status: "rejected", error: res.message, updatedAt: this.now().toISOString() });
      return { attempt, order: null };
    }
    const created = normalizeCreatedOrder(res.data);
    if (!created) {
      // 服务端回了成功但没有可识别订单号：不能当作未创建
      attempt = await this.d.repo.updateAttempt(attempt.id, { status: "outcome_unknown", error: "响应中无可识别订单号", updatedAt: this.now().toISOString() });
      throw new AppError("ORDER_OUTCOME_UNKNOWN", "服务端响应中未找到订单号，请在麦当劳 APP 核对", false, { attemptId: attempt.id });
    }
    const order: Order = {
      orderId: created.orderId, attemptId: attempt.id, storeCode: s.context.storeCode, payableFen: q.payableFen,
      payUrl: created.payUrl, serverStatus: null, statusCheckedAt: null,
    };
    await this.d.repo.saveOrder(order);
    attempt = await this.d.repo.updateAttempt(attempt.id, { status: "succeeded", orderId: created.orderId, updatedAt: this.now().toISOString() });
    return { attempt, order };
  }

  private async existingAttempt(auth: OrderAuthorization) {
    const a = await this.d.repo.getAttemptByAuthorization(auth.id);
    if (!a) return null;
    if (a.status === "outcome_unknown") throw new AppError("ORDER_OUTCOME_UNKNOWN", "上次创建结果不明，已冻结再次下单", false, { attemptId: a.id });
    return { attempt: a, order: a.orderId ? await this.d.repo.getOrder(a.orderId) : null };
  }

  // ---------- 订单状态 ----------
  async refreshOrder(orderId: string): Promise<Order> {
    const o = await this.d.repo.getOrder(orderId);
    if (!o) throw new AppError("VALIDATION", "只能查询本系统创建并保存的订单号");
    const res = await this.d.tools.call("queryOrder", { orderId: o.orderId }).catch((e) => {
      throw new AppError("MCP_ERROR", `订单查询失败：${(e as Error).message}`, true);
    });
    if (!res.ok) throw new AppError("MCP_ERROR", `订单查询失败：${res.message}`, true);
    const status = normalizeOrderStatus(res.data);
    const next = { ...o, serverStatus: status, statusCheckedAt: this.now().toISOString() };
    await this.d.repo.saveOrder(next);
    return next;
  }

  /**
   * 启动时调用：上次进程留下的 sending 无法判断远端是否已创建，统一标为 outcome_unknown；
   * prepared 尚未发送，标为 rejected（授权已消费，需要重新确认）。
   */
  async recoverStuckAttempts(): Promise<number> {
    const stuck = await this.d.repo.listAttempts(["prepared", "sending"]);
    for (const a of stuck) {
      await this.d.repo.updateAttempt(a.id, {
        status: a.status === "sending" ? "outcome_unknown" : "rejected",
        error: a.status === "sending" ? "进程在发送后中断，结果不明" : "进程在发送前中断",
        updatedAt: this.now().toISOString(),
      });
    }
    return stuck.length;
  }

  /** 失效钩子：注册到 AI-1 的 InvalidationSink / AI-2 的候选修改 */
  async invalidate(sessionId: string, candidateId?: string) {
    return this.d.repo.invalidateForSession(sessionId, candidateId);
  }
}
