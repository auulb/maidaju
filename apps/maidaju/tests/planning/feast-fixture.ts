import { DEMO_FACTS, DEMO_MEALS, DEMO_PRODUCTS, demoDetail } from "@/server/mcp/demo-data";
import { normalizeMeals, normalizeMealDetail } from "@/modules/catalog/normalize";
import type { PlanningContext } from "@/modules/catalog/types";

export function feastContext(count = 8, budgetFen = 30000): PlanningContext {
  const items = normalizeMeals(DEMO_MEALS, "demo", "fen").items;
  return {
    sessionId: "feast", sessionRevision: 1, mode: "mock", totalBudgetFen: budgetFen, memberCount: count, needTableware: false,
    members: Array.from({ length: count }, (_, i) => ({ memberId: `m${i}`, alias: `成员 ${i + 1}`, requiredMainCount: 1,
      hardAvoid: i < 2 ? ["spicy"] : i === 2 ? ["sugary_drink", "beef"] : [], softPrefer: [], budgetCapFen: null, revision: 1 })),
    menu: { id: "menu", mode: "mock", context: { beType: 1, orderType: 1, storeCode: "90000001" }, items, coupons: [],
      details: Object.fromEntries(DEMO_PRODUCTS.filter((p) => p.category === "combo").map((p) => [p.code, normalizeMealDetail(demoDetail(p.code), p.code, "demo", "2026-10-24")])),
      fetchedAt: "2026-10-24", sessionRevision: 1 },
    facts: Object.entries(DEMO_FACTS).flatMap(([code, attrs]) => Object.entries(attrs).map(([attribute, value]) => ({
      id: `menu:${code}:${attribute}`, subjectId: code, attribute: attribute as PlanningContext["facts"][number]["attribute"], value,
      status: "tool_supported", sourceRef: "demo", confirmedBy: null, basis: null, menuSnapshotId: "menu", observedAt: "2026-10-24",
    }))),
  };
}
