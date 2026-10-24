import { describe, expect, it } from "vitest";
import { feastContext } from "./feast-fixture";
import { buildPlanCatalog, memberItemStatus } from "@/modules/planning/catalog";
import { conservationErrors } from "@/modules/planning/build";
import { planMetrics } from "@/modules/planning/metrics";
import { objective, optimizeFeast } from "@/modules/planning/optimize";
import { service } from "./fixtures";

const cart = (d: { items: { productCode: string; quantity: number }[] }) => JSON.stringify(d.items.map((i) => [i.productCode, i.quantity]).sort());

describe("Skill 三目标与硬约束", () => {
  it("8 人 300 元：固定三种取向、不同购物车，营养差异来自实际餐品", async () => {
    const context = feastContext();
    const { svc } = service();
    const r = await svc.generate(context);
    expect(r.candidates.map((c) => c.profile)).toEqual(["variety", "fitness", "energy"]);
    expect(new Set(r.candidates.map(cart)).size).toBe(3);
    const [variety, fitness, energy] = r.candidates;
    expect(variety!.metrics.distinct).toBeGreaterThan(fitness!.metrics.distinct);
    expect(variety!.metrics.distinct).toBeGreaterThan(energy!.metrics.distinct);
    expect(fitness!.metrics.protein / fitness!.metrics.kcal).toBeGreaterThan(energy!.metrics.protein / energy!.metrics.kcal);
    expect(fitness!.metrics.fat).toBeLessThan(energy!.metrics.fat);
    expect(energy!.metrics.kcal).toBeGreaterThan(fitness!.metrics.kcal);
    expect(energy!.metrics.kcal).toBeGreaterThan(variety!.metrics.kcal);
    const catalog = new Map(buildPlanCatalog(context).items.map((p) => [p.code, p]));
    for (const c of r.candidates) {
      expect(c.hardConstraintStatus).toBe("pass");
      expect(c.estimatedTotalFen).toBeLessThanOrEqual(context.totalBudgetFen);
      expect(conservationErrors(c.items, c.assignments)).toEqual([]);
      expect(Object.values(c.estimatedMemberFen!).reduce((a, b) => a + b)).toBe(c.estimatedTotalFen);
      expect(c.metrics).toEqual(planMetrics(c.trays, c.shared, catalog));
      for (const member of context.members) {
        const own = c.trays[member.memberId]!.map((code) => catalog.get(code)!);
        expect(own.reduce((s, p) => s + p.roles.main, 0)).toBeGreaterThanOrEqual(1);
        expect(own.reduce((s, p) => s + p.roles.drink, 0)).toBeGreaterThanOrEqual(1);
        expect(own.every((p) => memberItemStatus(member, p).status === "pass")).toBe(true);
      }
    }
  });

  it("同输入同结果，不依赖随机服务或 AI", () => {
    const context = feastContext();
    expect(optimizeFeast(context, {}, () => 0).drafts).toEqual(optimizeFeast(context, {}, () => 0).drafts);
  });

  it("交叉忌口和个人上限：共享池也不能违反需求，分摊含共享成本", async () => {
    const context = feastContext();
    context.members[0]!.hardAvoid = ["spicy", "beef", "pork", "seafood", "sugary_drink"];
    context.members[0]!.budgetCapFen = 3000;
    context.members[1]!.budgetCapFen = 2500;
    const { svc } = service();
    const r = await svc.generate(context);
    expect(r.candidates).toHaveLength(3);
    const catalog = new Map(buildPlanCatalog(context).items.map((p) => [p.code, p]));
    for (const c of r.candidates) for (const m of context.members) {
      const touching = [...c.trays[m.memberId]!, ...c.shared.filter((s) => s.memberIds.includes(m.memberId)).map((s) => s.code)];
      expect(touching.every((code) => memberItemStatus(m, catalog.get(code)!).status === "pass")).toBe(true);
      if (m.budgetCapFen != null) expect(c.estimatedMemberFen![m.memberId]).toBeLessThanOrEqual(m.budgetCapFen);
    }
  });

  it("素食无主食、无饮品、超低预算均如实报冲突", () => {
    const veg = feastContext(); veg.members[0]!.hardAvoid = ["meat"];
    expect(optimizeFeast(veg).drafts).toEqual([]);
    expect(optimizeFeast(veg).conflicts[0]!.memberIds).toContain("m0");
    const noDrink = feastContext(); noDrink.menu.items = noDrink.menu.items.filter((p) => p.category !== "drink" && p.category !== "combo");
    expect(optimizeFeast(noDrink).drafts).toEqual([]);
    const low = optimizeFeast(feastContext(8, 5000));
    expect(low.drafts).toEqual([]); expect(low.conflicts[0]!.kind).toBe("total_budget");
  });

  it("最低预算只有一解时不强行复制三个购物车", async () => {
    const context = feastContext(2, 4000);
    context.menu.items = context.menu.items.filter((p) => ["MOCK-BASIC", "MOCK-TEA"].includes(p.code));
    context.members.forEach((m) => { m.hardAvoid = []; });
    const { svc } = service();
    const r = await svc.generate(context);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]!.metrics.roles).toMatchObject({ main: 2, drink: 2 });
  });

  it.each([1, 2, 6, 12, 20])("%i 人：三套有效结果，人数和预算扩大时仍受搜索限制保护", async (n) => {
    const { svc } = service();
    const r = await svc.generate(feastContext(n, n * 4000));
    expect(r.candidates).toHaveLength(3);
    for (const c of r.candidates) {
      expect(c.hardConstraintStatus).toBe("pass");
      expect(c.metrics.roles.main).toBeGreaterThanOrEqual(n);
      expect(c.metrics.roles.drink).toBeGreaterThanOrEqual(n);
      expect(c.estimatedTotalFen).toBeLessThanOrEqual(n * 4000);
    }
    expect(r.stats.nodes).toBeLessThanOrEqual(r.stats.limits.maxNodes + 5);
  });

  it("套餐默认子项参与忌口与份数，估算数据保留标记", () => {
    const { items } = buildPlanCatalog(feastContext());
    expect(items.find((p) => p.code === "MOCK-FIT-COMBO")!.roles).toEqual({ main: 1, drink: 1, side: 1, dessert: 0 });
    expect(items.find((p) => p.code === "MOCK-FIT-COMBO")!.sugarFree).toBe(true);
    expect(items.find((p) => p.code === "MOCK-WRAP")!.nutrition.estimated).toBe(true);
    expect(items.find((p) => p.code === "MOCK-BURGER-MILD")!.nutrition.source).toContain("MCP");
  });

  it("小菜单可枚举时，每种目标达到未被前一方案占用的购物车最高得分", () => {
    const context = feastContext(2, 10000);
    context.menu.items = context.menu.items.filter((p) => ["MOCK-BASIC", "MOCK-BURGER-MILD", "MOCK-TEA", "MOCK-ZERO"].includes(p.code));
    context.members.forEach((m) => { m.hardAvoid = []; });
    const out = optimizeFeast(context, {}, () => 0);
    const catalog = new Map(out.items.map((p) => [p.code, p]));
    const meals = [["MOCK-BASIC", "MOCK-TEA"], ["MOCK-BASIC", "MOCK-ZERO"], ["MOCK-BURGER-MILD", "MOCK-TEA"], ["MOCK-BURGER-MILD", "MOCK-ZERO"]];
    const used = new Set<string>();
    const signature = (trays: Record<string, string[]>) => JSON.stringify(Object.values(trays).flat().sort());
    for (const d of out.drafts) {
      const alternatives = meals.flatMap((a) => meals.map((b) => ({ m0: a, m1: b }))).filter((t) => !used.has(signature(t)));
      const best = Math.max(...alternatives.map((t) => objective(planMetrics(t, [], catalog), d.profile, 2)));
      expect(objective(planMetrics(d.trays, d.shared, catalog), d.profile, 2)).toBeGreaterThanOrEqual(best - 1e-6);
      used.add(signature(d.trays));
    }
  });
});
