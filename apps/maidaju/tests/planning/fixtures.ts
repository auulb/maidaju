// 模拟数据（MOCK）：仅用于 AI-2 规划测试。code 带 MOCK- 前缀，storeCode 为虚构数字。
import type { Fact, FactAttribute, MenuSnapshot, PlanningContext } from "@/modules/catalog/types";
import { PlanningContext as PlanningContextSchema } from "@/modules/catalog/types";
import type { MemberRequirement } from "@/modules/intake/types";
import { MemoryCandidateRepository } from "@/modules/planning/repo";
import { PlanningService } from "@/modules/planning/service";

type ItemSpec = { code: string; name: string; priceFen: number | null; category?: MenuSnapshot["items"][number]["category"] };

export const MENU_ID = "MENU-1";

export function menu(items: ItemSpec[], details: MenuSnapshot["details"] = {}): MenuSnapshot {
  return {
    id: MENU_ID,
    mode: "mock",
    context: { beType: 1, orderType: 1, storeCode: "90000001" },
    items: items.map((i) => ({
      code: i.code,
      name: i.name,
      priceFen: i.priceFen,
      priceRaw: i.priceFen,
      supportModify: null,
      toolCategoryName: null,
      category: i.category ?? "unknown",
      sourceRef: `mock#${i.code}`,
    })),
    coupons: [],
    details,
    fetchedAt: "2026-10-24T08:00:00.000Z",
    sessionRevision: 1,
  };
}

/** 构造一条事实；status 默认 user_confirmed（测试中代表组织者已确认） */
export function fact(code: string, attribute: FactAttribute, value: boolean | null, status: Fact["status"] = "user_confirmed"): Fact {
  return {
    id: `${MENU_ID}:${code}:${attribute}`,
    subjectId: code,
    attribute,
    value,
    status,
    sourceRef: null,
    confirmedBy: status === "user_confirmed" ? "organizer" : null,
    basis: status === "user_confirmed" ? "测试确认" : null,
    menuSnapshotId: MENU_ID,
    observedAt: "2026-10-24T08:00:00.000Z",
  };
}

export const STD_ITEMS: ItemSpec[] = [
  { code: "MOCK-BURGER", name: "模拟香辣鸡腿堡", priceFen: 2300 },
  { code: "MOCK-BURGER-MILD", name: "模拟板烧堡", priceFen: 2400 },
  { code: "MOCK-WRAP", name: "模拟鸡肉卷", priceFen: 1900 },
  { code: "MOCK-FRIES", name: "模拟薯条", priceFen: 1100, category: "side" },
  { code: "MOCK-COLA", name: "模拟可乐", priceFen: 900, category: "drink" },
  { code: "MOCK-ZERO", name: "模拟无糖可乐", priceFen: 900, category: "drink" },
];

/** 全部属性已确认的标准事实 */
export function stdFacts(over: Partial<Record<string, Partial<Record<FactAttribute, boolean>>>> = {}): Fact[] {
  const base: Record<string, Partial<Record<FactAttribute, boolean>>> = {
    "MOCK-BURGER": { is_main: true, contains_spicy: true, is_sugary_drink: false },
    "MOCK-BURGER-MILD": { is_main: true, contains_spicy: false, is_sugary_drink: false },
    "MOCK-WRAP": { is_main: true, contains_spicy: false, is_sugary_drink: false },
    "MOCK-FRIES": { is_main: false, contains_spicy: false, is_sugary_drink: false },
    "MOCK-COLA": { is_main: false, contains_spicy: false, is_sugary_drink: true },
    "MOCK-ZERO": { is_main: false, contains_spicy: false, is_sugary_drink: false },
  };
  for (const [k, v] of Object.entries(over)) base[k] = { ...base[k], ...v };
  return Object.entries(base).flatMap(([code, attrs]) => Object.entries(attrs).map(([a, v]) => fact(code, a as FactAttribute, v!)));
}

/** 6 人：m1/m2 不吃辣，m3 不喝含糖饮料 */
export function sixMembers(over: Partial<Record<string, Partial<MemberRequirement>>> = {}): MemberRequirement[] {
  return Array.from({ length: 6 }, (_, i) => {
    const id = `m${i + 1}`;
    const m: MemberRequirement = {
      memberId: id,
      alias: `成员${i + 1}`,
      requiredMainCount: 1,
      hardAvoid: i < 2 ? ["spicy"] : i === 2 ? ["sugary_drink"] : [],
      softPrefer: [],
      budgetCapFen: null,
      revision: 1,
    };
    return { ...m, ...over[id] };
  });
}

export function ctx(p: { members?: MemberRequirement[]; items?: ItemSpec[]; facts?: Fact[]; budgetFen?: number; details?: MenuSnapshot["details"]; revision?: number } = {}): PlanningContext {
  const members = p.members ?? sixMembers();
  return PlanningContextSchema.parse({
    sessionId: "S1",
    sessionRevision: p.revision ?? 1,
    mode: "mock",
    totalBudgetFen: p.budgetFen ?? 15000,
    memberCount: members.length,
    needTableware: false,
    members,
    menu: menu(p.items ?? STD_ITEMS, p.details ?? {}),
    facts: p.facts ?? stdFacts(),
  });
}

export function service(search = {}) {
  let seq = 0;
  // 固定时钟：测试不依赖机器速度触发时间预算
  const repo = new MemoryCandidateRepository();
  const svc = new PlanningService({
    repo,
    now: () => "2026-10-24T08:00:00.000Z",
    newId: () => `C${++seq}`,
    clockMs: () => 0,
    search,
  });
  return { repo, svc };
}
