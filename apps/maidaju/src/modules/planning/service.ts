// AI-2 规划服务：生成候选（B2）、手工调整与局部重配（B4）、交接快照与实价复核（B6）。
// 不调用 MCP、不持有凭据、不创建订单。
import type { CheckoutSnapshot, ConstraintCheck, Fen } from "@/contracts";
import { CheckoutSnapshot as CheckoutSnapshotSchema } from "@/contracts";
import { AppError } from "@/server/errors";
import { allocateMembers, checkBudgets } from "../checkout/allocation";
import type { SnapshotSource } from "../checkout/service";
import type { PlanningContext } from "../catalog/types";
import type { InvalidationReason, InvalidationSink } from "../ports";
import { buildOrder, estimate } from "./build";
import { buildPlanCatalog, memberItemStatus } from "./catalog";
import { checkCandidate } from "./check";
import { optimizeFeast } from "./optimize";
import { planMetrics } from "./metrics";
import { priceCart } from "./pricing";
import type { CandidateRepository } from "./repo";
import { beam, enumerateTrays, memberPool, type Draft, type Tray } from "./search";
import {
  DEFAULT_SEARCH,
  PROFILE_LABEL,
  type Candidate,
  type Conflict,
  type GenerateResult,
  type PlanItem,
  type SearchOptions,
  type SearchStats,
  type SharedPick,
} from "./types";

export type PlanningDeps = {
  repo: CandidateRepository;
  now: () => string;
  newId: () => string;
  clockMs?: () => number;
  search?: Partial<SearchOptions>;
};

export type ManualEdit = {
  /** 覆盖指定成员的独享商品；未列出的成员保持不变 */
  trays?: Record<string, string[]>;
  /** 提供时整体替换共享项 */
  shared?: SharedPick[];
};

export type ReplanResult = { candidate: Candidate | null; conflicts: Conflict[]; changedMemberIds: string[] };

export type QuoteInput = {
  payableFen: Fen;
  lineAmountsFen: Record<string, Fen> | null;
  /** 组织者确认的分摊表（服务端缺少行金额时使用）；合计必须等于 payableFen */
  organizerAllocationFen?: Record<string, Fen> | null;
};

export type PricedChecks = {
  status: "pass" | "pending" | "fail";
  memberAllocatedFen: Record<string, Fen> | null;
  allocationSource: "server_lines" | "organizer" | "none";
  checks: ConstraintCheck[];
};

export class PlanningService implements SnapshotSource, InvalidationSink {
  constructor(private d: PlanningDeps) {}

  private opts(): SearchOptions {
    return { ...DEFAULT_SEARCH, ...this.d.search };
  }

  /** 由 trays + shared 组装并校验一个候选版本（纯计算，不落库） */
  private assemble(
    ctx: PlanningContext,
    items: PlanItem[],
    draft: Draft,
    meta: { id: string; version: number; search: SearchStats | null; changes: Candidate["changes"] },
  ): Candidate {
    const catalog = new Map(items.map((i) => [i.code, i]));
    const memberOrder = ctx.members.map((m) => m.memberId);
    const { items: orderItems, assignments } = buildOrder(draft.trays, draft.shared, memberOrder, catalog);
    const est = estimate(orderItems, assignments, memberOrder, catalog, ctx.pricing);
    const { checks, status, unresolvedFactIds } = checkCandidate({
      members: ctx.members,
      items: orderItems,
      assignments,
      catalog,
      menuCodes: new Set(ctx.menu.items.map((i) => i.code)),
      totalBudgetFen: ctx.totalBudgetFen,
      estimatedTotalFen: est.totalFen,
      estimatedMemberFen: est.memberFen,
    });
    return {
      id: meta.id,
      version: meta.version,
      sessionId: ctx.sessionId,
      sessionRevision: ctx.sessionRevision,
      mode: ctx.mode,
      menuSnapshotId: ctx.menu.id,
      context: ctx.menu.context,
      needTableware: ctx.needTableware,
      memberOrder,
      memberBudgetCapFen: Object.fromEntries(ctx.members.map((m) => [m.memberId, m.budgetCapFen])),
      totalBudgetFen: ctx.totalBudgetFen,
      profile: draft.profile,
      label: PROFILE_LABEL[draft.profile],
      trays: draft.trays,
      shared: draft.shared,
      items: orderItems,
      assignments,
      checks,
      hardConstraintStatus: status,
      unresolvedFactIds,
      estimatedTotalFen: est.totalFen,
      estimatedMemberFen: est.memberFen,
      priceSource: est.totalFen == null ? "unknown" : "estimate",
      metrics: planMetrics(draft.trays, draft.shared, catalog),
      pricing: orderItems.every((i) => catalog.get(i.productCode)?.priceFen != null) ? priceCart(orderItems.map((i) => ({ code: i.productCode, unitFen: catalog.get(i.productCode)!.priceFen!, quantity: i.quantity })), ctx.pricing) : null,
      status: "active",
      staleReason: null,
      search: meta.search,
      changes: meta.changes,
      createdAt: this.d.now(),
    };
  }

  // ---------- B2 生成 ----------
  async generate(ctx: PlanningContext): Promise<GenerateResult> {
    const out = optimizeFeast(ctx, this.opts(), this.d.clockMs);
    // 生成新一批时，本局旧的活跃候选全部被替代
    for (const c of await this.d.repo.listBySession(ctx.sessionId)) {
      if (c.status === "active") await this.d.repo.setStatus(c.id, c.version, "superseded", "已重新生成候选");
    }
    const candidates: Candidate[] = [];
    const conflicts = [...out.conflicts];
    for (const draft of out.drafts) {
      const c = this.assemble(ctx, out.items, draft, { id: this.d.newId(), version: 1, search: out.stats, changes: [] });
      if (c.hardConstraintStatus === "fail") {
        // 搜索阶段已排除明确违反项；若校验器仍判 fail，说明存在结构问题，不输出该候选
        conflicts.push({
          kind: "structure",
          memberIds: [],
          constraint: "structure",
          factIds: [],
          reason: c.checks.filter((x) => x.status === "fail").map((x) => x.reason).join("；"),
          suggestions: ["刷新菜单后重新生成"],
        });
        continue;
      }
      await this.d.repo.insert(c);
      candidates.push(c);
    }
    return { candidates, conflicts, stats: out.stats, message: summaryMessage(candidates.length, out.stats, conflicts) };
  }

  // ---------- B4 手工调整：生成新版本，旧版本 superseded（旧报价随之失效） ----------
  async applyManualEdit(ctx: PlanningContext, candidateId: string, expectedVersion: number, edit: ManualEdit): Promise<Candidate> {
    const base = await this.requireLatest(candidateId, expectedVersion);
    this.assertSameContext(ctx, base);
    const memberIds = new Set(base.memberOrder);
    for (const m of Object.keys(edit.trays ?? {})) if (!memberIds.has(m)) throw new AppError("VALIDATION", `成员 ${m} 不在本局`);
    for (const s of edit.shared ?? []) {
      if (!Number.isInteger(s.quantity) || s.quantity <= 0) throw new AppError("VALIDATION", "共享数量必须为正整数");
      if (s.memberIds.length < 2 || s.memberIds.some((m) => !memberIds.has(m))) throw new AppError("VALIDATION", "共享项至少 2 位本局成员");
    }
    const menuCodes = new Set(ctx.menu.items.map((i) => i.code));
    const unknown = [...Object.values(edit.trays ?? {}).flat(), ...(edit.shared ?? []).map((s) => s.code)].find((c) => !menuCodes.has(c));
    if (unknown) throw new AppError("MENU_CHANGED", `商品 ${unknown} 不在当前菜单快照`);

    const trays = { ...base.trays, ...(edit.trays ?? {}) };
    const shared = edit.shared ?? base.shared;
    const changes = [
      ...Object.keys(edit.trays ?? {}).map((m) => ({ memberId: m, reason: "组织者手工调整餐盘" })),
      ...(edit.shared ? [{ memberId: null, reason: "组织者手工调整共享项" }] : []),
    ];
    const { items } = buildPlanCatalog(ctx);
    const next = this.assemble(ctx, items, { profile: "manual", trays, shared }, { id: base.id, version: base.version + 1, search: null, changes });
    return this.commitVersion(base, next);
  }

  // ---------- B4 局部重配：以旧方案为基线，优先保留未受影响成员 ----------
  async replanAffectedMembers(ctx: PlanningContext, candidateId: string, expectedVersion: number, affected: string[]): Promise<ReplanResult> {
    const base = await this.requireLatest(candidateId, expectedVersion);
    if (base.menuSnapshotId !== ctx.menu.id || base.mode !== ctx.mode) {
      throw new AppError("MENU_CHANGED", "菜单已变化，请重新生成候选而不是局部重配");
    }
    const opts = this.opts();
    const { items } = buildPlanCatalog(ctx);
    const catalog = new Map(items.map((i) => [i.code, i]));
    const byId = new Map(ctx.members.map((m) => [m.memberId, m]));
    const changes: Candidate["changes"] = [];
    const affectedSet = new Set(affected.filter((m) => byId.has(m)));

    // 1) 未点名成员：若原餐盘在新上下文下出现明确违反或不可构建，才纳入重配并记录原因
    for (const m of ctx.members) {
      if (affectedSet.has(m.memberId)) continue;
      const tray = base.trays[m.memberId];
      if (!tray) {
        affectedSet.add(m.memberId);
        changes.push({ memberId: m.memberId, reason: "新加入成员，需要分配餐盘" });
        continue;
      }
      const broken = tray.find((c) => {
        const p = catalog.get(c);
        return !p || !p.buildable || memberItemStatus(m, p).status === "fail";
      });
      if (broken) {
        affectedSet.add(m.memberId);
        changes.push({ memberId: m.memberId, reason: `原餐盘中 ${catalog.get(broken)?.name ?? broken} 已不可用或与其要求冲突` });
      }
    }

    // 2) 共享项：任一参与者被移除或产生明确违反则移除，并记录原因
    const shared: SharedPick[] = [];
    for (const s of base.shared) {
      const p = catalog.get(s.code);
      const members = s.memberIds.filter((x) => byId.has(x));
      const bad = !p || members.length < 2 || members.some((x) => memberItemStatus(byId.get(x)!, p).status === "fail");
      if (bad) changes.push({ memberId: null, reason: `共享项 ${p?.name ?? s.code} 与参与成员的新要求冲突，已移除` });
      else shared.push({ ...s, memberIds: members });
    }

    const kept = ctx.members.filter((m) => !affectedSet.has(m.memberId));
    const toPlan = ctx.members.filter((m) => affectedSet.has(m.memberId));
    const keptTrays = Object.fromEntries(kept.map((m) => [m.memberId, base.trays[m.memberId]!]));
    const price = (codes: string[]) => (codes.some((c) => catalog.get(c)?.priceFen == null) ? null : codes.reduce((s, c) => s + catalog.get(c)!.priceFen!, 0));
    const keptCost = [...Object.values(keptTrays), ...shared.flatMap((s) => Array(s.quantity).fill(s.code) as string[])].map((cs) => (Array.isArray(cs) ? price(cs) : price([cs])));
    const knownKept = keptCost.some((x) => x == null) ? null : (keptCost as number[]).reduce((a, b) => a + b, 0);
    const remaining = knownKept == null ? null : ctx.totalBudgetFen - knownKept;

    // 3) 受影响成员：原餐盘若仍合法则不动（变动惩罚最大化），否则枚举新餐盘
    const traysByMember: Tray[][] = [];
    const conflicts: Conflict[] = [];
    for (const m of toPlan) {
      const pool = memberPool(m, items, opts);
      let { trays } = enumerateTrays(m, pool, opts);
      const old = base.trays[m.memberId];
      if (old) {
        const oldKey = [...old].sort().join();
        const idx = trays.findIndex((t) => [...t.codes].sort().join() === oldKey);
        if (idx > 0) trays = [trays[idx]!, ...trays.slice(0, idx), ...trays.slice(idx + 1)];
      }
      trays = trays.filter((t) => m.budgetCapFen == null || t.priceFen == null || t.priceFen <= m.budgetCapFen);
      if (!trays.length) {
        conflicts.push({
          kind: "no_eligible_main",
          memberIds: [m.memberId],
          constraint: "required_main",
          factIds: [],
          reason: `${m.alias}：按新要求在当前菜单中找不到可行餐盘`,
          suggestions: ["放宽该成员的不能接受项", "确认更多商品的属性信息", "提高该成员个人上限"],
        });
      }
      traysByMember.push(trays);
    }
    if (conflicts.length) return { candidate: null, conflicts, changedMemberIds: [] };

    const clock = { start: (this.d.clockMs ?? Date.now)(), now: this.d.clockMs ?? Date.now, nodes: 0 };
    const r = beam(toPlan, traysByMember, "budget", remaining, opts, clock);
    const pick = r.states[0];
    if (!pick) {
      return {
        candidate: null,
        changedMemberIds: [],
        conflicts: [
          {
            kind: "total_budget",
            memberIds: toPlan.map((m) => m.memberId),
            constraint: "total_budget",
            factIds: [],
            reason: `保留其他成员现有餐盘时，受影响成员在剩余预算 ${remaining ?? "未知"} 分内${r.truncated ? "（搜索已截断）" : ""}未找到可行组合`,
            suggestions: ["提高总预算", "允许调整其他成员或共享项（需您选择）", "放宽受影响成员的要求"],
          },
        ],
      };
    }

    const trays: Record<string, string[]> = { ...keptTrays };
    const changed: string[] = [];
    toPlan.forEach((m, i) => {
      const codes = pick.picks[i]!.codes;
      trays[m.memberId] = codes;
      const old = base.trays[m.memberId];
      if (!old || [...old].sort().join() !== [...codes].sort().join()) {
        changed.push(m.memberId);
        if (!changes.some((c) => c.memberId === m.memberId)) changes.push({ memberId: m.memberId, reason: "按该成员的新要求重新搭配" });
      }
    });
    // 只保留真正产生变动的成员说明
    const finalChanges = changes.filter((c) => c.memberId === null || changed.includes(c.memberId));
    const ordered = Object.fromEntries(ctx.members.map((m) => [m.memberId, trays[m.memberId]!]));
    const stats: SearchStats = { elapsedMs: clock.now() - clock.start, nodes: clock.nodes, truncated: r.truncated, limits: opts };
    const next = this.assemble(ctx, items, { profile: "replan", trays: ordered, shared }, { id: base.id, version: base.version + 1, search: stats, changes: finalChanges });
    const committed = await this.commitVersion(base, next);
    return { candidate: committed, conflicts: [], changedMemberIds: changed };
  }

  // ---------- B6 交接：SnapshotSource ----------
  async getLatestVersion(candidateId: string): Promise<number | null> {
    const c = await this.d.repo.latest(candidateId);
    return c && c.status === "active" ? c.version : null;
  }

  async getCheckoutSnapshot(candidateId: string, version: number): Promise<CheckoutSnapshot | null> {
    const c = await this.d.repo.get(candidateId, version);
    if (!c || c.status !== "active") return null;
    return CheckoutSnapshotSchema.parse({
      sessionId: c.sessionId,
      sessionRevision: c.sessionRevision,
      candidateId: c.id,
      candidateVersion: c.version,
      mode: c.mode,
      menuSnapshotId: c.menuSnapshotId,
      context: c.context,
      items: c.items,
      assignments: c.assignments,
      memberIds: c.memberOrder,
      memberBudgetCapFen: c.memberBudgetCapFen,
      totalBudgetFen: c.totalBudgetFen,
      needTableware: c.needTableware,
      hardConstraintStatus: c.hardConstraintStatus,
      unresolvedFactIds: c.unresolvedFactIds,
    });
  }

  // ---------- InvalidationSink：需求/门店/菜单/事实变化时候选全部失效 ----------
  async invalidate(sessionId: string, reason: InvalidationReason, newRevision: number): Promise<void> {
    for (const c of await this.d.repo.listBySession(sessionId)) {
      if (c.status === "active" && c.sessionRevision < newRevision) {
        await this.d.repo.setStatus(c.id, c.version, "stale", `${REASON_TEXT[reason]}，需重新检查/核价`);
      }
    }
  }

  async listActive(sessionId: string): Promise<Candidate[]> {
    return (await this.d.repo.listBySession(sessionId)).filter((c) => c.status === "active");
  }

  // ---------- helpers ----------
  private async requireLatest(candidateId: string, expectedVersion: number): Promise<Candidate> {
    const latest = await this.d.repo.latest(candidateId);
    if (!latest) throw new AppError("VALIDATION", `候选 ${candidateId} 不存在`, false, { notFound: true });
    if (latest.version !== expectedVersion) throw new AppError("STALE_REVISION", "候选已被修改，请刷新后再操作", false, { latest: latest.version });
    if (latest.status !== "active") throw new AppError("STALE_REVISION", latest.staleReason ?? "候选已失效，请重新生成");
    return latest;
  }

  private assertSameContext(ctx: PlanningContext, base: Candidate) {
    if (base.menuSnapshotId !== ctx.menu.id || base.mode !== ctx.mode || base.sessionId !== ctx.sessionId) {
      throw new AppError("MENU_CHANGED", "菜单或会话已变化，请重新生成候选");
    }
  }

  private async commitVersion(base: Candidate, next: Candidate): Promise<Candidate> {
    if (!(await this.d.repo.insert(next))) throw new AppError("STALE_REVISION", "候选版本冲突，请刷新后重试");
    await this.d.repo.setStatus(base.id, base.version, "superseded", `已被版本 ${next.version} 替代`);
    return next;
  }
}

const REASON_TEXT: Record<InvalidationReason, string> = {
  session_changed: "点餐局设置已修改",
  members_changed: "成员需求已修改",
  store_changed: "门店已更换",
  menu_refreshed: "菜单已刷新",
  fact_confirmed: "商品事实已更新",
};

export function summaryMessage(n: number, stats: SearchStats, conflicts: Conflict[]): string {
  const trunc = stats.truncated ? "（搜索已按上限截断，不代表不存在其他方案）" : "";
  if (n === 0) return `当前搜索范围内未找到可行方案${trunc}。${conflicts[0]?.reason ?? ""}`.trim();
  if (n === 1) return `当前搜索范围内只找到 1 套不同方案${trunc}，未复制凑数。`;
  return `生成 ${n} 套不同候选${trunc}；价格为估算或待核价，以服务端核价为准。`;
}

/**
 * B6：用服务端核价结果复核整局与个人预算。
 * 优先使用服务端行金额做“本局记账分摊”；否则只接受组织者确认且合计等于实付的分摊表；
 * 两者都没有时个人上限保持 pending，绝不显示通过。
 */
export function validatePricedCandidate(snapshot: CheckoutSnapshot, quote: QuoteInput): PricedChecks {
  let allocated = allocateMembers(snapshot, quote.lineAmountsFen, quote.payableFen);
  let source: PricedChecks["allocationSource"] = allocated ? "server_lines" : "none";
  const checks: ConstraintCheck[] = [];
  if (!allocated && quote.organizerAllocationFen) {
    const t = quote.organizerAllocationFen;
    const keysOk = snapshot.memberIds.every((m) => Number.isSafeInteger(t[m]) && t[m]! >= 0) && Object.keys(t).every((k) => snapshot.memberIds.includes(k));
    const sum = Object.values(t).reduce((a, b) => a + b, 0);
    if (keysOk && sum === quote.payableFen) {
      allocated = { ...t };
      source = "organizer";
    } else {
      checks.push({ memberId: null, constraint: "allocation", status: "pending", factIds: [], reason: `组织者分摊表合计 ${sum} 分与实付 ${quote.payableFen} 分不一致或成员不全` });
    }
  }
  const b = checkBudgets(snapshot, quote.payableFen, allocated);
  if (snapshot.totalBudgetFen != null) {
    checks.push({
      memberId: null,
      constraint: "total_budget",
      status: quote.payableFen > snapshot.totalBudgetFen ? "fail" : "pass",
      factIds: [],
      reason: `实付 ${quote.payableFen} 分 / 预算 ${snapshot.totalBudgetFen} 分`,
    });
  }
  for (const m of snapshot.memberIds) {
    const cap = snapshot.memberBudgetCapFen[m];
    if (cap == null) continue;
    const v = allocated?.[m];
    checks.push({
      memberId: m,
      constraint: "member_budget",
      status: v == null ? "pending" : v > cap ? "fail" : "pass",
      factIds: [],
      reason: v == null ? "缺少可分配的金额明细，需组织者确认分摊表" : `分摊 ${v} 分 / 上限 ${cap} 分（本局记账分摊）`,
    });
  }
  const status = checks.some((c) => c.status === "fail") || b.status === "fail" ? "fail" : checks.some((c) => c.status === "pending") || b.status === "pending" ? "pending" : "pass";
  return { status, memberAllocatedFen: allocated, allocationSource: source, checks };
}
