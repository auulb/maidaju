// B1：确定性约束检查器（无 LLM）。未知事实一律 pending，绝不判 pass。
import type { Assignment, ConstraintCheck, Fen, OrderItem } from "@/contracts";
import { HARD_AVOID_LABEL, type MemberRequirement } from "../intake/types";
import { memberItemStatus } from "./catalog";
import { conservationErrors } from "./build";
import type { PlanItem, Tri } from "./types";

export type CheckInput = {
  members: MemberRequirement[];
  items: OrderItem[];
  assignments: Assignment[];
  catalog: Map<string, PlanItem>;
  menuCodes: Set<string>;
  totalBudgetFen: Fen | null;
  estimatedTotalFen: Fen | null;
  estimatedMemberFen: Record<string, Fen> | null;
};

export type CheckResult = { checks: ConstraintCheck[]; status: Tri; unresolvedFactIds: string[] };

const combine = (xs: Tri[]): Tri => (xs.includes("fail") ? "fail" : xs.includes("pending") ? "pending" : "pass");

export function checkCandidate(input: CheckInput): CheckResult {
  const checks: ConstraintCheck[] = [];
  const add = (c: ConstraintCheck) => checks.push(c);
  const codeOf = new Map(input.items.map((i) => [i.lineId, i.productCode]));

  // 结构：商品来自当前菜单快照、可构建、数量正整数、分配守恒
  const structural: string[] = [];
  for (const i of input.items) {
    if (!input.menuCodes.has(i.productCode)) structural.push(`商品 ${i.productCode} 不在当前菜单快照`);
    const p = input.catalog.get(i.productCode);
    if (p && !p.buildable) structural.push(`${p.name}：${p.unbuildableReason}`);
    if (!Number.isInteger(i.quantity) || i.quantity <= 0) structural.push(`行 ${i.lineId} 数量非法`);
  }
  structural.push(...conservationErrors(input.items, input.assignments));
  add({
    memberId: null,
    constraint: "structure",
    status: structural.length ? "fail" : "pass",
    factIds: [],
    reason: structural.length ? structural.join("；") : "商品来自当前菜单，数量与分配守恒",
  });

  for (const m of input.members) {
    const own = input.assignments.filter((a) => !a.shared && a.memberIds.length === 1 && a.memberIds[0] === m.memberId);
    const touching = input.assignments.filter((a) => a.memberIds.includes(m.memberId));

    // 主食：只统计独享主食（共享主食不计入最低要求）；unknown 计入 pending
    let yes = 0;
    let unknown = 0;
    const mainFacts: string[] = [];
    for (const a of own) {
      const p = input.catalog.get(codeOf.get(a.lineId) ?? "");
      if (!p) continue;
      if (p.main.status === "yes") yes += a.quantity;
      else if (p.main.status === "unknown") {
        unknown += a.quantity;
        mainFacts.push(...p.main.factIds);
      }
    }
    const need = m.requiredMainCount;
    const mainStatus: Tri = yes >= need ? "pass" : yes + unknown >= need ? "pending" : "fail";
    add({
      memberId: m.memberId,
      constraint: "required_main",
      status: mainStatus,
      factIds: mainStatus === "pending" ? [...new Set(mainFacts)] : [],
      reason:
        mainStatus === "pass"
          ? `已分配 ${yes} 份已核实主食（要求 ${need}）`
          : mainStatus === "pending"
            ? `已分配 ${yes} 份已核实主食、${unknown} 份主食属性待确认（要求 ${need}）`
            : `独享主食 ${yes + unknown} 份，少于要求 ${need} 份`,
    });

    // 不能接受项：独享与共享都要检查
    for (const h of m.hardAvoid) {
      const parts: Tri[] = [];
      const fids: string[] = [];
      const bad: string[] = [];
      const unsure: string[] = [];
      for (const a of touching) {
        const p = input.catalog.get(codeOf.get(a.lineId) ?? "");
        if (!p) continue;
        const r = memberItemStatus({ hardAvoid: [h] }, p);
        parts.push(r.status);
        fids.push(...r.factIds);
        if (r.status === "fail") bad.push(p.name);
        if (r.status === "pending") unsure.push(p.name);
      }
      const st = combine(parts);
      add({
        memberId: m.memberId,
        constraint: `avoid:${h}`,
        status: st,
        factIds: [...new Set(fids)],
        reason:
          st === "pass"
            ? `${HARD_AVOID_LABEL[h]}：所分配商品均有依据不含该项`
            : st === "fail"
              ? `${HARD_AVOID_LABEL[h]}：${bad.join("、")} 有依据表明不符合`
              : `${HARD_AVOID_LABEL[h]}：${unsure.join("、")} 缺少可靠属性，待确认`,
      });
    }

    // 个人预算（估算）
    if (m.budgetCapFen != null) {
      const v = input.estimatedMemberFen?.[m.memberId];
      const st: Tri = v == null ? "pending" : v > m.budgetCapFen ? "fail" : "pass";
      add({
        memberId: m.memberId,
        constraint: "member_budget",
        status: st,
        factIds: [],
        reason: v == null ? "缺少可靠价格，个人预算待核价" : `估算 ${v} 分 / 上限 ${m.budgetCapFen} 分`,
      });
    }
  }

  if (input.totalBudgetFen != null) {
    const v = input.estimatedTotalFen;
    const st: Tri = v == null ? "pending" : v > input.totalBudgetFen ? "fail" : "pass";
    add({
      memberId: null,
      constraint: "total_budget",
      status: st,
      factIds: [],
      reason: v == null ? "缺少可靠价格，整局预算待核价" : `估算 ${v} 分 / 预算 ${input.totalBudgetFen} 分`,
    });
  }

  const status = combine(checks.map((c) => c.status));
  const unresolvedFactIds = [...new Set(checks.filter((c) => c.status === "pending").flatMap((c) => c.factIds))].sort();
  return { checks, status, unresolvedFactIds };
}
