import type { PlanItem, PlanMetrics, SharedPick } from "./types";

export function planMetrics(trays: Record<string, string[]>, shared: SharedPick[], catalog: Map<string, PlanItem>): PlanMetrics {
  const counts = new Map<string, number>();
  for (const codes of Object.values(trays)) for (const code of codes) counts.set(code, (counts.get(code) ?? 0) + 1);
  for (const s of shared) counts.set(s.code, (counts.get(s.code) ?? 0) + s.quantity);
  const m: PlanMetrics = { kcal: 0, protein: 0, fat: 0, carb: 0, sodium: 0, distinct: counts.size, quantity: 0, sugarFreeDrinks: 0, roles: { main: 0, drink: 0, side: 0, dessert: 0 }, estimated: false };
  for (const [code, q] of counts) {
    const p = catalog.get(code);
    if (!p) continue;
    m.quantity += q;
    for (const key of ["kcal", "protein", "fat", "carb", "sodium"] as const) m[key] += p.nutrition[key] * q;
    for (const key of ["main", "drink", "side", "dessert"] as const) m.roles[key] += p.roles[key] * q;
    if (p.sugarFree) m.sugarFreeDrinks += p.roles.drink * q;
    m.estimated ||= p.nutrition.estimated;
  }
  return m;
}
