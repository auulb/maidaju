// Skill 的三目标纯代码实现。确定性多起点 + 坐标替换 + 加购/删除/两项交换；所有提交都经过逐人和整单硬约束。
import type { PlanningContext } from "../catalog/types";
import type { MemberRequirement } from "../intake/types";
import { buildPlanCatalog, memberItemStatus } from "./catalog";
import { buildOrder, estimate } from "./build";
import { checkCandidate } from "./check";
import { planMetrics } from "./metrics";
import { priceCart } from "./pricing";
import { largestRemainder } from "../checkout/allocation";
import type { Draft, SearchOutcome } from "./search";
import { DEFAULT_SEARCH, type CandidateProfile, type PlanItem, type PlanMetrics, type SearchOptions } from "./types";

type Option = { codes: string[]; cost: number | null; pending: boolean };
export const objective = (m: PlanMetrics, profile: CandidateProfile, n: number): number => {
  const categories = Object.values(m.roles).filter((q) => q > 0).length;
  if (profile === "variety") return m.distinct * 60 + categories * 14 + m.quantity * 3 + (m.roles.dessert ? 6 : 0) - 10 * (m.quantity - m.distinct) - .4 * Math.max(0, m.kcal - 820 * n);
  if (profile === "fitness") return m.protein * 9 - m.fat * 1.6 - m.carb + m.sugarFreeDrinks * 4 + m.distinct * 12 - .6 * Math.max(0, m.kcal - 700 * n) - 2.5 * Math.max(0, m.fat - 28 * n) - .3 * Math.max(0, m.sodium - 2000 * n);
  return m.kcal + 3 * m.protein + categories * 10 + m.distinct * 8 - 1.5 * Math.max(0, m.kcal - 1000 * n);
};
const keyOf = (d: Draft) => {
  const q = new Map<string, number>();
  for (const code of Object.values(d.trays).flat()) q.set(code, (q.get(code) ?? 0) + 1);
  for (const s of d.shared) q.set(s.code, (q.get(s.code) ?? 0) + s.quantity);
  return JSON.stringify([...q].sort(([a], [b]) => a.localeCompare(b)));
};

export function optimizeFeast(ctx: PlanningContext, partial: Partial<SearchOptions> = {}, now: () => number = Date.now): SearchOutcome {
  const opts = { ...DEFAULT_SEARCH, ...partial };
  const start = now();
  let nodes = 0, truncated = false;
  const { items } = buildPlanCatalog(ctx);
  const catalog = new Map(items.map((p) => [p.code, p]));
  const memberOrder = ctx.members.map((m) => m.memberId);
  const sum = (codes: string[]) => codes.some((c) => catalog.get(c)!.priceFen == null) ? null : codes.reduce((s, c) => s + catalog.get(c)!.priceFen!, 0);
  const safe = (m: MemberRequirement, p: PlanItem) => p.buildable && memberItemStatus(m, p).status !== "fail";
  const pools: Option[][] = ctx.members.map((m) => {
    const mains = items.filter((p) => p.roles.main > 0 && safe(m, p));
    const drinks = items.filter((p) => p.category === "drink" && safe(m, p));
    const combos: string[][] = [];
    const enumerate = (codes: string[], index: number, left: number) => {
      if (combos.length >= 800) { truncated = true; return; }
      if (left <= 0) { combos.push(codes); return; }
      for (let i = index; i < mains.length; i++) {
        if (combos.length >= 800) { truncated = true; break; }
        enumerate([...codes, mains[i]!.code], i, left - mains[i]!.roles.main);
      }
    };
    enumerate([], 0, m.requiredMainCount);
    return combos.flatMap((codes) => {
      const hasDrink = codes.some((c) => catalog.get(c)!.roles.drink > 0);
      return (hasDrink ? [codes] : drinks.map((d) => [...codes, d.code])).map((cs) => ({ codes: cs, cost: sum(cs), pending: cs.some((c) => memberItemStatus(m, catalog.get(c)!).status === "pending" || catalog.get(c)!.main.status === "unknown") }));
    }).filter((o) => m.budgetCapFen == null || o.cost == null || (ctx.pricing?.rules.length ?? 0) > 0 || o.cost <= m.budgetCapFen)
      .sort((a, b) => Number(a.pending) - Number(b.pending) || (a.cost ?? Infinity) - (b.cost ?? Infinity) || a.codes.join().localeCompare(b.codes.join()));
  });
  const conflicts: SearchOutcome["conflicts"] = [];
  for (let i = 0; i < pools.length; i++) if (!pools[i]!.length) conflicts.push({
    kind: "no_eligible_main", memberIds: [memberOrder[i]!], constraint: "required_meal",
    factIds: [], reason: `${ctx.members[i]!.alias}：没有同时满足主食、饮品、忌口及个人预算的餐盘`,
    suggestions: ["提高个人预算", "调整主食份数或忌口", "更换菜单；素食主食不足时不能用小食替代"],
  });
  const stats = () => ({ elapsedMs: now() - start, nodes, truncated, limits: opts });
  if (conflicts.length) return { drafts: [], conflicts, items, stats: stats() };
  const base: Draft = { profile: "variety", trays: Object.fromEntries(memberOrder.map((id, i) => [id, pools[i]![0]!.codes])), shared: [] };
  const evaluate = (d: Draft, profile: CandidateProfile) => {
    nodes++;
    const allocated = ctx.members.map((m) => sum(d.trays[m.memberId]!));
    for (const s of d.shared) {
      const cost = catalog.get(s.code)!.priceFen! * s.quantity;
      const participants = memberOrder.filter((id) => s.memberIds.includes(id));
      participants.forEach((id, j) => { const i = memberOrder.indexOf(id); if (allocated[i] != null) allocated[i]! += Math.floor(cost / participants.length) + (j < cost % participants.length ? 1 : 0); });
    }
    const total = allocated.some((v) => v == null) ? null : (allocated as number[]).reduce((s, v) => s + v, 0);
    let payable = total;
    if (total != null && ctx.pricing) {
      payable = priceCart([...Object.values(d.trays).flat().map((code) => ({ code, unitFen: catalog.get(code)!.priceFen!, quantity: 1 })), ...d.shared.map((s) => ({ code: s.code, unitFen: catalog.get(s.code)!.priceFen!, quantity: s.quantity }))], ctx.pricing).payableFen;
      const split = largestRemainder(payable, memberOrder.map((id, i) => [id, allocated[i] ?? 0]));
      if (split) memberOrder.forEach((id, i) => { allocated[i] = split[id]!; });
    }
    if (payable != null && payable > ctx.totalBudgetFen) return -Infinity;
    for (let i = 0; i < ctx.members.length; i++) if (ctx.members[i]!.budgetCapFen != null && allocated[i] != null && allocated[i]! > ctx.members[i]!.budgetCapFen!) return -Infinity;
    const metrics = planMetrics(d.trays, d.shared, catalog);
    const pending = Object.entries(d.trays).reduce((n, [id, cs]) => n + cs.filter((c) => memberItemStatus(ctx.members.find((m) => m.memberId === id)!, catalog.get(c)!).status === "pending" || catalog.get(c)!.main.status === "unknown").length, 0);
    const pref = ctx.members.reduce((s, m) => {
      const codes = [...d.trays[m.memberId]!, ...d.shared.filter((p) => p.memberIds.includes(m.memberId)).map((p) => p.code)];
      return s + m.softPrefer.filter((p) => codes.some((c) => catalog.get(c)!.name.includes(p))).length;
    }, 0);
    return objective(metrics, profile, ctx.memberCount) + pref * 20 - pending * 10000;
  };
  // 团餐门槛有跳变：最低菜单价超预算时也尝试补到活动档位后再判无解。
  if (evaluate(base, "variety") === -Infinity && ctx.pricing?.rules.length) {
    const extra = items.filter((p) => p.main.status === "no" && p.priceFen != null && p.priceFen > 0 && p.category !== "drink")
      .find((p) => ctx.members.every((m) => memberItemStatus(m, p).status === "pass"));
    if (extra) {
      const original = Object.values(base.trays).reduce((s, cs) => s + (sum(cs) ?? 0), 0);
      for (const rule of ctx.pricing.rules) {
        const q = Math.ceil(Math.max(0, rule.thresholdFen - original) / extra.priceFen!);
        const proposal = { ...base, shared: q ? [{ code: extra.code, quantity: q, memberIds: memberOrder }] : [] };
        if (evaluate(proposal, "variety") !== -Infinity) { base.shared = proposal.shared; break; }
      }
    }
  }
  if (evaluate(base, "variety") === -Infinity) return {
    drafts: [], items, stats: stats(), conflicts: [{ kind: "total_budget", memberIds: memberOrder, constraint: "total_budget", factIds: [],
      reason: `当前范围内的主食 + 饮品基础方案原价约 ¥${((Object.values(base.trays).reduce((s, cs) => s + (sum(cs) ?? 0), 0)) / 100).toFixed(2)}，加入费用和活动后未能同时满足总预算与个人上限`,
      suggestions: ["提高总预算", "减少主食份数", "更换门店"] }],
  };
  const exhausted = () => {
    if (nodes >= opts.maxNodes || now() - start > opts.timeBudgetMs) { truncated = true; return true; }
    return false;
  };
  // 共享只分给允许吃该商品的成员，受限成员不会被计入成本分摊。
  const extras = items.filter((p) => p.buildable && p.priceFen != null && p.priceFen > 0 && p.main.status === "no" && p.category !== "drink")
    .map((p) => ({ code: p.code, quantity: 1, memberIds: ctx.members.filter((m) => memberItemStatus(m, p).status === "pass").map((m) => m.memberId) }))
    .filter((s) => s.memberIds.length >= Math.min(2, ctx.memberCount));
  const results = new Map<string, { draft: Draft; score: number }[]>();
  // 无加购且组合空间较小时穷举，给出该范围内的精确最优；大菜单走有界启发式。
  const exact: Draft[] = [];
  const combinations = pools.reduce((s, p) => s * p.length, 1);
  if (!extras.length && combinations <= Math.min(10000, opts.maxNodes / 3)) {
    const enumerate = (index: number, trays: Draft["trays"]) => {
      if (index === pools.length) { exact.push({ profile: "variety", trays, shared: [] }); return; }
      for (const option of pools[index]!) enumerate(index + 1, { ...trays, [memberOrder[index]!]: option.codes });
    };
    enumerate(0, {});
  }
  // 每个目标独享节点额度，避免前一个目标耗尽整个搜索预算。
  for (const profile of ["variety", "fitness", "energy"] as const) {
    const candidates: { draft: Draft; score: number }[] = [];
    const profileLimit = Math.floor(opts.maxNodes / 3) * (results.size + 1);
    for (let seed = 0; seed < 3 && !exhausted() && nodes < profileLimit; seed++) {
      let current: Draft = { ...base, profile, trays: structuredClone(base.trays), shared: structuredClone(base.shared) };
      if (seed > 0 && ctx.pricing?.rules.length && extras.length) {
        const rule = ctx.pricing.rules[(seed - 1) % ctx.pricing.rules.length]!;
        const original = Object.values(base.trays).reduce((s, cs) => s + (sum(cs) ?? 0), 0);
        const extra = extras[seed % extras.length]!;
        const q = Math.ceil(Math.max(0, rule.thresholdFen - original) / catalog.get(extra.code)!.priceFen!);
        const proposal = { ...current, shared: q ? [{ ...extra, quantity: q }] : [] };
        if (evaluate(proposal, profile) !== -Infinity) current = proposal;
      }
      let score = evaluate(current, profile);
      // 正反成员顺序和循环起点，减少个人预算不均导致的先到先得偏差。
      const order = memberOrder.map((_, i) => (seed % 2 ? memberOrder.length - 1 - i : (i + seed) % memberOrder.length));
      for (let round = 0; round < 8 && !exhausted() && nodes < profileLimit; round++) {
        let improved = false;
        for (const i of order) {
          let best = current, bestScore = score;
          for (const option of pools[i]!) {
            if (exhausted() || nodes >= profileLimit) break;
            const next = { ...current, trays: { ...current.trays, [memberOrder[i]!]: option.codes } };
            const value = evaluate(next, profile);
            if (value > bestScore + 1e-6) { best = next; bestScore = value; }
          }
          if (best !== current) { current = best; score = bestScore; improved = true; }
        }
        // 比较添加、删除、替换共享项，使预算可从小食重新流回主食。
        for (let step = 0; step < ctx.memberCount * 2 && !exhausted() && nodes < profileLimit; step++) {
          let best = current, bestScore = score;
          const consider = (d: Draft) => {
            if (exhausted() || nodes >= profileLimit) return;
            const value = evaluate(d, profile);
            if (value > bestScore + 1e-6) { best = d; bestScore = value; }
          };
          for (const extra of extras) {
            if (current.shared.length < Math.ceil(ctx.memberCount / 2) + 2) consider({ ...current, shared: [...current.shared, extra] });
          }
          for (let j = 0; j < current.shared.length; j++) {
            const removed = current.shared.filter((_, k) => j !== k);
            consider({ ...current, shared: removed });
            for (const extra of extras) consider({ ...current, shared: [...removed, extra] });
          }
          if (best === current) break;
          current = best; score = bestScore; improved = true;
        }
        candidates.push({ draft: current, score });
        if (!improved) break;
      }
      // 固定 PRNG 与降温序列：允许暂时降低目标分数，跨过「降饮品价 → 加小食」等局部最优。
      let randomState = 2166136261 + seed * 97 + (profile === "energy" ? 31 : profile === "fitness" ? 17 : 0);
      const random = () => { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return randomState / 4294967296; };
      let walk = current, walkScore = score;
      for (let step = 0; step < 1800 && !exhausted() && nodes < profileLimit; step++) {
        let next: Draft = { ...walk, trays: { ...walk.trays }, shared: [...walk.shared] };
        const move = Math.floor(random() * 6);
        const i = Math.floor(random() * pools.length);
        if (move <= 2 || !extras.length) {
          next.trays[memberOrder[i]!] = pools[i]![Math.floor(random() * pools[i]!.length)]!.codes;
          if (move === 1) {
            const j = Math.floor(random() * pools.length);
            next.trays[memberOrder[j]!] = pools[j]![Math.floor(random() * pools[j]!.length)]!.codes;
          }
          if (move === 2 && extras.length && next.shared.length < Math.ceil(ctx.memberCount / 2) + 2) next.shared.push(extras[Math.floor(random() * extras.length)]!);
        } else if (move === 3 && next.shared.length < Math.ceil(ctx.memberCount / 2) + 2) next.shared.push(extras[Math.floor(random() * extras.length)]!);
        else if (move === 4 && next.shared.length) next.shared.splice(Math.floor(random() * next.shared.length), 1);
        else if (next.shared.length) next.shared[Math.floor(random() * next.shared.length)] = extras[Math.floor(random() * extras.length)]!;
        const value = evaluate(next, profile);
        const temperature = (profile === "energy" ? 180 : profile === "fitness" ? 45 : 30) * Math.pow(.015, step / 1800);
        if (Number.isFinite(value) && (value >= walkScore || random() < Math.exp((value - walkScore) / temperature))) { walk = next; walkScore = value; }
        if (value > score + 1e-6) { current = next; score = value; }
      }
      candidates.push({ draft: current, score });
    }
    for (const d of exact) {
      if (exhausted() || nodes >= profileLimit) break;
      const score = evaluate(d, profile);
      if (Number.isFinite(score)) candidates.push({ draft: { ...d, profile }, score });
    }
    if (!candidates.length) candidates.push({ draft: { ...base, profile }, score: evaluate(base, profile) });
    results.set(profile, candidates.sort((a, b) => b.score - a.score));
  }
  // 每种目标也评估其他目标找到的购物车，再选择最好的不同清单。
  // 防止能量方案落在另一个目标已经找出的更高热量方案之下。
  const allFound = [...results.values()].flat().map((c) => c.draft);
  for (const [profile, choices] of results) {
    for (const d of allFound) {
      if (exhausted()) break;
      const score = evaluate(d, profile as CandidateProfile);
      if (Number.isFinite(score)) choices.push({ draft: { ...d, profile: profile as CandidateProfile }, score });
    }
    choices.sort((a, b) => b.score - a.score);
  }
  const drafts: Draft[] = [];
  const seen = new Set<string>();
  for (const [profile, candidates] of results) {
    let pick = candidates.find((c) => Number.isFinite(c.score) && !seen.has(keyOf(c.draft)))?.draft;
    // 目标可能收敛到同一购物车：在相同目标下选得分最高的合法邻居，不复制购物车。
    if (!pick) {
      const origin = candidates[0]!.draft;
      const neighbors: { draft: Draft; score: number }[] = [];
      for (let i = 0; i < pools.length; i++) for (const o of pools[i]!) {
        if (exhausted()) break;
        const d = { ...origin, trays: { ...origin.trays, [memberOrder[i]!]: o.codes } };
        if (!seen.has(keyOf(d))) neighbors.push({ draft: d, score: evaluate(d, profile as CandidateProfile) });
      }
      pick = neighbors.filter((c) => Number.isFinite(c.score)).sort((a, b) => b.score - a.score)[0]?.draft;
    }
    if (!pick) continue;
    const built = buildOrder(pick.trays, pick.shared, memberOrder, catalog);
    const est = estimate(built.items, built.assignments, memberOrder, catalog, ctx.pricing);
    const check = checkCandidate({ members: ctx.members, ...built, catalog, menuCodes: new Set(catalog.keys()), totalBudgetFen: ctx.totalBudgetFen, estimatedTotalFen: est.totalFen, estimatedMemberFen: est.memberFen });
    if (check.status === "fail") continue;
    seen.add(keyOf(pick)); drafts.push(pick);
  }
  return { drafts: drafts.slice(0, opts.maxCandidates), conflicts, items, stats: stats() };
}
