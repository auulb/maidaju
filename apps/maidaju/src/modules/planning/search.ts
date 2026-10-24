// B2：规则筛选 + 有界组合搜索（beam search）+ 去重排序。不承诺全局最优。
import type { Fen } from "@/contracts";
import type { PlanningContext } from "../catalog/types";
import type { MemberRequirement } from "../intake/types";
import { buildPlanCatalog, memberItemStatus } from "./catalog";
import { buildOrder, estimate } from "./build";
import { checkCandidate } from "./check";
import {
  DEFAULT_SEARCH,
  PROFILE_LABEL,
  type CandidateProfile,
  type Conflict,
  type PlanItem,
  type SearchOptions,
  type SearchStats,
  type SharedPick,
  type Tri,
} from "./types";

export type Tray = { codes: string[]; priceFen: Fen | null; hard: Tri; prefHits: number; factIds: string[] };

export type Draft = {
  profile: CandidateProfile;
  trays: Record<string, string[]>;
  shared: SharedPick[];
};

/** 软偏好仅用于排序；不产生任何硬事实 */
export function prefHits(m: MemberRequirement, items: PlanItem[]): number {
  let n = 0;
  for (const p of m.softPrefer) {
    const kw = p.trim();
    if (kw && items.some((i) => i.name.includes(kw))) n++;
  }
  return n;
}

const rankTri = (t: Tri) => (t === "pass" ? 0 : t === "pending" ? 1 : 2);
const sumPrice = (xs: (Fen | null)[]): Fen | null => (xs.some((x) => x == null) ? null : (xs as Fen[]).reduce((a, b) => a + b, 0));

/** 组合（可重复）：从 pool 中选 k 个，按字典序 */
function multisets<T>(pool: T[], k: number, limit: number): { out: T[][]; truncated: boolean } {
  const out: T[][] = [];
  let truncated = false;
  const rec = (start: number, acc: T[]) => {
    if (out.length >= limit) return void (truncated = true);
    if (acc.length === k) return void out.push([...acc]);
    for (let i = start; i < pool.length; i++) rec(i, [...acc, pool[i]!]);
  };
  rec(0, []);
  return { out, truncated };
}

export type MemberPool = { mains: PlanItem[]; addons: PlanItem[]; excluded: { item: PlanItem; reason: string }[] };

/** 按成员硬约束筛选：明确违反的排除；未知保留并标 pending */
export function memberPool(m: MemberRequirement, items: PlanItem[], opts: SearchOptions): MemberPool {
  const excluded: MemberPool["excluded"] = [];
  const ok = items.filter((i) => {
    if (!i.buildable) return excluded.push({ item: i, reason: i.unbuildableReason ?? "不可构建" }), false;
    const s = memberItemStatus(m, i);
    if (s.status === "fail") return excluded.push({ item: i, reason: `违反：${s.failed.join(",")}` }), false;
    return true;
  });
  const order = (a: PlanItem, b: PlanItem) => {
    const sa = rankTri(memberItemStatus(m, a).status) - rankTri(memberItemStatus(m, b).status);
    if (sa) return sa;
    const ma = (a.main.status === "yes" ? 0 : 1) - (b.main.status === "yes" ? 0 : 1);
    if (ma) return ma;
    return (a.priceFen ?? Number.MAX_SAFE_INTEGER) - (b.priceFen ?? Number.MAX_SAFE_INTEGER) || a.code.localeCompare(b.code);
  };
  const mains = ok.filter((i) => i.main.status !== "no").sort(order).slice(0, opts.maxMainsConsidered);
  const addons = ok.filter((i) => i.addon).sort(order).slice(0, opts.maxAddonsConsidered);
  return { mains, addons, excluded };
}

export function enumerateTrays(m: MemberRequirement, pool: MemberPool, opts: SearchOptions): { trays: Tray[]; truncated: boolean } {
  const k = m.requiredMainCount;
  const { out: mainSets, truncated: t1 } = multisets(pool.mains, k, 500);
  const raw: PlanItem[][] = [];
  for (const ms of mainSets) {
    raw.push(ms);
    for (const a of pool.addons) raw.push([...ms, a]);
  }
  const trays: Tray[] = raw.map((xs) => {
    let hard: Tri = "pass";
    const fids: string[] = [];
    for (const x of xs) {
      const s = memberItemStatus(m, x);
      if (rankTri(s.status) > rankTri(hard)) hard = s.status;
      fids.push(...s.factIds);
      if (x.main.status === "unknown") fids.push(...x.main.factIds);
    }
    if (k > 0 && xs.filter((x) => x.main.status !== "no").length < k) hard = "fail";
    if (xs.some((x) => x.main.status === "unknown") && hard === "pass") hard = "pending";
    return { codes: xs.map((x) => x.code), priceFen: sumPrice(xs.map((x) => x.priceFen)), hard, prefHits: prefHits(m, xs), factIds: [...new Set(fids)] };
  });
  const sorted = trays
    .filter((t) => t.hard !== "fail")
    .sort((a, b) => rankTri(a.hard) - rankTri(b.hard) || (a.priceFen ?? Infinity) - (b.priceFen ?? Infinity) || a.codes.join().localeCompare(b.codes.join()));
  return { trays: sorted.slice(0, opts.maxTraysPerMember), truncated: t1 || sorted.length > opts.maxTraysPerMember };
}

type State = { picks: Tray[]; cost: Fen | null; hardRank: number; pref: number };

function stateScore(s: State, profile: CandidateProfile): number[] {
  const cost = s.cost ?? Number.MAX_SAFE_INTEGER;
  if (profile === "preference") return [s.hardRank, -s.pref, cost];
  return [s.hardRank, cost, -s.pref];
}
const lexLess = (a: number[], b: number[]) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
};

/** 多人组合 beam search；按总预算剪枝（仅在价格已知时） */
export function beam(
  members: MemberRequirement[],
  traysByMember: Tray[][],
  profile: CandidateProfile,
  budgetFen: Fen | null,
  opts: SearchOptions,
  clock: { start: number; now: () => number; nodes: number },
): { states: State[]; truncated: boolean } {
  let frontier: State[] = [{ picks: [], cost: 0, hardRank: 0, pref: 0 }];
  let truncated = false;
  let exhausted = false;
  for (let i = 0; i < members.length && !exhausted; i++) {
    const next: State[] = [];
    outer: for (const s of frontier) {
      for (const t of traysByMember[i]!) {
        if (++clock.nodes > opts.maxNodes || clock.now() - clock.start > opts.timeBudgetMs) {
          truncated = exhausted = true;
          break outer;
        }
        const cost = s.cost == null || t.priceFen == null ? null : s.cost + t.priceFen;
        if (budgetFen != null && cost != null && cost > budgetFen) continue;
        next.push({ picks: [...s.picks, t], cost, hardRank: Math.max(s.hardRank, rankTri(t.hard)), pref: s.pref + t.prefHits });
      }
    }
    next.sort((a, b) => lexLess(stateScore(a, profile), stateScore(b, profile)));
    if (next.length > opts.beamWidth) truncated = true;
    frontier = next.slice(0, opts.beamWidth);
    if (!frontier.length) break;
  }
  return { states: frontier.filter((s) => s.picks.length === members.length), truncated };
}

/** 适度共享：按固定顺序分组，每组添加一份全组都不违反硬约束的最便宜加购项 */
export function addSharing(
  members: MemberRequirement[],
  trays: Record<string, string[]>,
  items: PlanItem[],
  groupSize: number,
  remainingFen: Fen | null,
): SharedPick[] {
  if (groupSize < 2) return [];
  const addons = items.filter((i) => i.addon && i.buildable).sort((a, b) => (a.priceFen ?? Infinity) - (b.priceFen ?? Infinity) || a.code.localeCompare(b.code));
  const out: SharedPick[] = [];
  let left = remainingFen;
  for (let g = 0; g + 1 < members.length; g += groupSize) {
    const group = members.slice(g, g + groupSize);
    if (group.length < 2) break;
    const pick = addons.find((a) => {
      if (group.some((m) => memberItemStatus(m, a).status === "fail")) return false;
      if (group.some((m) => (trays[m.memberId] ?? []).includes(a.code))) return false; // 不重复已有
      return left == null || (a.priceFen != null && a.priceFen <= left);
    });
    if (!pick) continue;
    if (left != null && pick.priceFen != null) left -= pick.priceFen;
    out.push({ code: pick.code, quantity: 1, memberIds: group.map((m) => m.memberId) });
  }
  return out;
}

export const draftKey = (d: Pick<Draft, "trays" | "shared">) =>
  JSON.stringify([
    Object.entries(d.trays).sort(([a], [b]) => a.localeCompare(b)).map(([m, c]) => [m, [...c].sort()]),
    [...d.shared].map((s) => [s.code, s.quantity, [...s.memberIds].sort()]).sort(),
  ]);

/** 订单层面的去重：商品与数量相同即视为同一方案（仅分配不同不算不同候选） */
export const cartKey = (d: Pick<Draft, "trays" | "shared">) => {
  const q = new Map<string, number>();
  for (const cs of Object.values(d.trays)) for (const c of cs) q.set(c, (q.get(c) ?? 0) + 1);
  for (const s of d.shared) q.set(s.code, (q.get(s.code) ?? 0) + s.quantity);
  return JSON.stringify([...q].sort(([a], [b]) => a.localeCompare(b)));
};

export type SearchOutcome = {
  drafts: Draft[];
  conflicts: Conflict[];
  stats: SearchStats;
  items: PlanItem[];
};

export function searchCandidates(ctx: PlanningContext, partial: Partial<SearchOptions> = {}, now: () => number = Date.now): SearchOutcome {
  const opts: SearchOptions = { ...DEFAULT_SEARCH, ...partial };
  const clock = { start: now(), now, nodes: 0 };
  const { items } = buildPlanCatalog(ctx);
  const members = ctx.members;
  const conflicts: Conflict[] = [];
  let truncated = false;

  const traysByMember: Tray[][] = [];
  for (const m of members) {
    const pool = memberPool(m, items, opts);
    const { trays, truncated: t } = enumerateTrays(m, pool, opts);
    truncated ||= t;
    if (!trays.length) {
      conflicts.push({
        kind: "no_eligible_main",
        memberIds: [m.memberId],
        constraint: "required_main",
        factIds: [],
        reason: pool.mains.length
          ? `${m.alias}：可用主食不足 ${m.requiredMainCount} 份`
          : `${m.alias}：当前菜单中没有可分配的主食（主食属性未知的商品也已全部被硬约束排除或不可构建）`,
        suggestions: ["放宽该成员的不能接受项", "确认更多商品的主食/属性信息", "更换门店"],
      });
    }
    if (m.budgetCapFen != null && trays.length && trays.every((t) => t.priceFen != null && t.priceFen > m.budgetCapFen!)) {
      conflicts.push({
        kind: "member_budget",
        memberIds: [m.memberId],
        constraint: "member_budget",
        factIds: [],
        reason: `${m.alias}：最便宜的可行餐盘估算 ${Math.min(...trays.map((t) => t.priceFen!))} 分，超过个人上限 ${m.budgetCapFen} 分`,
        suggestions: ["提高该成员个人上限", "允许使用共享项", "以核价结果为准（可能有门店优惠）"],
      });
    }
    // 个人上限内的餐盘优先；但不在此处硬删（共享与优惠可能影响），由检查器判定
    traysByMember.push(trays.filter((t) => m.budgetCapFen == null || t.priceFen == null || t.priceFen <= m.budgetCapFen));
  }

  const drafts: Draft[] = [];
  if (!conflicts.length) {
    const seenCart = new Set<string>();
    const tryAdd = (d: Draft) => {
      const k = cartKey(d);
      if (seenCart.has(k)) return false;
      seenCart.add(k);
      drafts.push(d);
      return true;
    };
    const toTrays = (picks: Tray[]) => Object.fromEntries(members.map((m, i) => [m.memberId, picks[i]!.codes]));

    for (const profile of ["budget", "preference", "sharing"] as const) {
      if (drafts.length >= opts.maxCandidates) break;
      const r = beam(members, traysByMember, profile === "sharing" ? "budget" : profile, ctx.totalBudgetFen, opts, clock);
      truncated ||= r.truncated;
      for (const s of r.states) {
        const trays = toTrays(s.picks);
        const shared = profile === "sharing" ? addSharing(members, trays, items, opts.sharingGroupSize, s.cost == null ? null : ctx.totalBudgetFen - s.cost) : [];
        if (profile === "sharing" && !shared.length) break; // 没有可共享项就不冒充“适度共享”
        if (tryAdd({ profile, trays, shared })) break;
      }
    }

    if (!drafts.length) {
      conflicts.push({
        kind: ctx.totalBudgetFen != null && traysByMember.every((t) => t.length) ? "total_budget" : "search_exhausted",
        memberIds: members.map((m) => m.memberId),
        constraint: "total_budget",
        factIds: [],
        reason: truncated
          ? "在当前搜索范围内未找到满足总预算的组合（搜索已按上限截断）"
          : "在当前搜索范围内未找到满足总预算的组合",
        suggestions: ["提高总预算", "减少部分成员的主食数量要求", "更换门店", "以核价结果为准（可能有门店优惠）"],
      });
    }
  }

  return {
    drafts,
    conflicts,
    items,
    stats: { elapsedMs: now() - clock.start, nodes: clock.nodes, truncated, limits: opts },
  };
}

export { PROFILE_LABEL, buildOrder, estimate, checkCandidate };
