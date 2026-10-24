// B1：把 PlanningContext 标准化为规划目录。只使用已有事实/工具字段，不从商品名推断任何属性。
import type { OrderItem } from "@/contracts";
import type { Fact, FactAttribute, MealDetail, PlanningContext } from "../catalog/types";
import { AVOID_TO_ATTRIBUTE } from "../catalog/facts";
import type { HardAvoid, MemberRequirement } from "../intake/types";
import type { MainStatus, PlanItem, Tri } from "./types";

/** 只有工具证据或用户确认的事实才算“已核实” */
const isVerified = (f: Fact) => f.status === "tool_supported" || f.status === "user_confirmed";

export type FactIndex = { menuSnapshotId: string; map: Map<string, Fact> }; // `${subjectId}:${attribute}` -> Fact

export function indexFacts(facts: Fact[], menuSnapshotId: string): FactIndex {
  const map = new Map<string, Fact>();
  for (const f of facts) if (f.menuSnapshotId === menuSnapshotId) map.set(`${f.subjectId}:${f.attribute}`, f);
  return { menuSnapshotId, map };
}

/**
 * 缺少事实记录时仍生成稳定 ID（与 AI-1 factId 格式一致），
 * 确保每个 pending 都能进入 unresolvedFactIds，由 AI-3 的 FACT_PENDING 闸门拦截。
 */
const pendingId = (idx: FactIndex, code: string, attr: FactAttribute) => `${idx.menuSnapshotId}:${code}:${attr}`;

/** 单个商品对单个“含有X”属性的判定：含有=fail，不含=pass，未知=pending，冲突=fail */
export function avoidStatus(idx: FactIndex, code: string, attr: FactAttribute): { status: Tri; factIds: string[] } {
  const f = idx.map.get(`${code}:${attr}`);
  if (!f) return { status: "pending", factIds: [pendingId(idx, code, attr)] };
  if (f.status === "conflict") return { status: "fail", factIds: [f.id] };
  if (!isVerified(f) || f.value === null) return { status: "pending", factIds: [f.id] };
  return { status: f.value ? "fail" : "pass", factIds: [f.id] };
}

function mainStatus(idx: FactIndex, code: string, category: string): { status: MainStatus; factIds: string[]; sourceRef: string | null } {
  const f = idx.map.get(`${code}:is_main`);
  if (f && isVerified(f) && f.value !== null) return { status: f.value ? "yes" : "no", factIds: [f.id], sourceRef: f.sourceRef };
  if (f?.status === "conflict") return { status: "no", factIds: [f.id], sourceRef: f.sourceRef };
  // 工具给出的明确非主食分类（side/drink/dessert）可以排除，但 "main" 分类本身不足以确认（需事实）
  if (category === "side" || category === "drink" || category === "dessert") return { status: "no", factIds: [], sourceRef: null };
  return { status: "unknown", factIds: [f ? f.id : pendingId(idx, code, "is_main")], sourceRef: null };
}

/** 套餐：每个轮次取详情中 isDefault 的选项；缺详情或缺默认项则不可构建 */
export function defaultRoundList(detail: MealDetail | undefined): { roundList: OrderItem["roundList"]; reason: string | null } {
  if (!detail) return { roundList: undefined, reason: "缺少套餐详情，无法构建套餐轮次" };
  if (!detail.rounds.length) return { roundList: undefined, reason: "套餐详情没有轮次" };
  const roundList = [];
  for (const r of detail.rounds) {
    const defaults = r.choices.filter((c) => c.isDefault);
    if (defaults.length !== 1) return { roundList: undefined, reason: `套餐轮次「${r.name}」默认项数量为 ${defaults.length}，需用户选择` };
    roundList.push({ round: r.round, comboItemList: [{ code: defaults[0]!.code, quantity: 1 }] });
  }
  return { roundList, reason: null };
}

const worst = (a: Tri, b: Tri): Tri => (a === "fail" || b === "fail" ? "fail" : a === "pending" || b === "pending" ? "pending" : "pass");

export function buildPlanCatalog(ctx: PlanningContext): { items: PlanItem[]; facts: FactIndex } {
  const idx = indexFacts(ctx.facts, ctx.menu.id);
  const attrs = new Set<FactAttribute>(ctx.members.flatMap((m) => m.hardAvoid.map((h) => AVOID_TO_ATTRIBUTE[h])));
  const items: PlanItem[] = ctx.menu.items.map((it) => {
    const isCombo = it.category === "combo";
    const combo = isCombo ? defaultRoundList(ctx.menu.details[it.code]) : { roundList: undefined, reason: null };
    const componentCodes = combo.roundList?.flatMap((r) => r.comboItemList.map((c) => c.code)) ?? [];
    const avoid: PlanItem["avoid"] = {};
    for (const a of attrs) {
      // 套餐：套餐本身与所有默认组件取最严格结果
      let s = avoidStatus(idx, it.code, a);
      for (const c of componentCodes) {
        const cs = avoidStatus(idx, c, a);
        s = { status: worst(s.status, cs.status), factIds: [...s.factIds, ...cs.factIds] };
      }
      avoid[a] = s;
    }
    const main = mainStatus(idx, it.code, it.category);
    const components = componentCodes.map((code) => ctx.menu.items.find((p) => p.code === code)?.nutrition);
    const componentNutrition = isCombo && components.length > 0 && components.every((n) => n != null)
      ? { kcal: 0, protein: 0, fat: 0, carb: 0, sodium: 0, estimated: components.some((n) => n!.estimated), source: "默认套餐组件营养相加" } : null;
    if (componentNutrition) for (const n of components) for (const key of ["kcal", "protein", "fat", "carb", "sodium"] as const) componentNutrition[key] += n![key];
    return {
      code: it.code,
      name: it.name,
      priceFen: it.priceFen,
      category: it.category,
      nutrition: componentNutrition ?? it.nutrition ?? {
        kcal: main.status !== "no" ? 380 : it.category === "drink" ? 100 : 180,
        protein: main.status !== "no" ? 18 : 2, fat: main.status !== "no" ? 15 : 4,
        carb: main.status !== "no" ? 38 : 25, sodium: main.status !== "no" ? 800 : 100,
        estimated: true, source: "同类餐品估算，非官方数据",
      },
      roles: {
        main: main.status !== "no" ? Math.max(1, componentCodes.filter((c) => mainStatus(idx, c, ctx.menu.items.find((i) => i.code === c)?.category ?? "unknown").status === "yes").length) : 0,
        drink: it.category === "drink" ? 1 : componentCodes.filter((c) => ctx.menu.items.find((i) => i.code === c)?.category === "drink").length,
        side: it.category === "side" ? 1 : componentCodes.filter((c) => ctx.menu.items.find((i) => i.code === c)?.category === "side").length,
        dessert: it.category === "dessert" ? 1 : componentCodes.filter((c) => ctx.menu.items.find((i) => i.code === c)?.category === "dessert").length,
      },
      sugarFree: avoidStatus(idx, it.code, "is_sugary_drink").status === "pass" && componentCodes.every((c) => avoidStatus(idx, c, "is_sugary_drink").status === "pass"),
      main,
      addon: main.status === "no",
      roundList: combo.roundList,
      buildable: !isCombo || combo.reason === null,
      unbuildableReason: combo.reason,
      avoid,
    };
  });
  return { items, facts: idx };
}

/** 成员对商品的硬约束结果（只看该成员已确认的硬约束） */
export function memberItemStatus(m: Pick<MemberRequirement, "hardAvoid">, item: PlanItem): { status: Tri; factIds: string[]; failed: HardAvoid[] } {
  let status: Tri = "pass";
  const factIds: string[] = [];
  const failed: HardAvoid[] = [];
  for (const h of m.hardAvoid) {
    const r = item.avoid[AVOID_TO_ATTRIBUTE[h]] ?? { status: "pending" as Tri, factIds: [] };
    status = worst(status, r.status);
    if (r.status !== "pass") factIds.push(...r.factIds);
    if (r.status === "fail") failed.push(h);
  }
  return { status, factIds, failed };
}
