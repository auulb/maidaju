// B1：由“逐人餐盘 + 共享项”构建订单 items 与分配 assignments，以及估算金额。
// 一个商品 code 合并为一行；每位成员每份独享为一条 assignment；共享项一条 assignment 记录参与成员。
import type { Assignment, Fen, OrderItem } from "@/contracts";
import { largestRemainder } from "../checkout/allocation";
import type { PlanItem, SharedPick } from "./types";

export const lineIdOf = (code: string) => `L:${code}`;

export function buildOrder(
  trays: Record<string, string[]>,
  shared: SharedPick[],
  memberOrder: string[],
  catalog: Map<string, PlanItem>,
): { items: OrderItem[]; assignments: Assignment[] } {
  const qty = new Map<string, number>();
  const assignments: Assignment[] = [];
  for (const m of memberOrder) {
    const counts = new Map<string, number>();
    for (const code of trays[m] ?? []) counts.set(code, (counts.get(code) ?? 0) + 1);
    for (const [code, q] of counts) {
      qty.set(code, (qty.get(code) ?? 0) + q);
      assignments.push({ lineId: lineIdOf(code), memberIds: [m], quantity: q, shared: false });
    }
  }
  for (const s of shared) {
    qty.set(s.code, (qty.get(s.code) ?? 0) + s.quantity);
    const ordered = memberOrder.filter((m) => s.memberIds.includes(m));
    assignments.push({ lineId: lineIdOf(s.code), memberIds: ordered, quantity: s.quantity, shared: true });
  }
  // 按首次出现顺序稳定输出
  const items: OrderItem[] = [];
  for (const [code, q] of qty) {
    const p = catalog.get(code);
    const item: OrderItem = { lineId: lineIdOf(code), productCode: code, quantity: q };
    if (p?.roundList) item.roundList = structuredClone(p.roundList);
    items.push(item);
  }
  return { items, assignments };
}

/** 估算：任一商品缺价格则整体 null（不填 0）；共享项均摊，尾差按成员顺序最大余数法 */
export function estimate(
  items: OrderItem[],
  assignments: Assignment[],
  memberOrder: string[],
  catalog: Map<string, PlanItem>,
): { totalFen: Fen | null; memberFen: Record<string, Fen> | null } {
  let total = 0;
  for (const i of items) {
    const p = catalog.get(i.productCode)?.priceFen;
    if (p == null) return { totalFen: null, memberFen: null };
    total += p * i.quantity;
  }
  const member: Record<string, number> = Object.fromEntries(memberOrder.map((m) => [m, 0]));
  for (const a of assignments) {
    const code = items.find((i) => i.lineId === a.lineId)!.productCode;
    const amount = catalog.get(code)!.priceFen! * a.quantity;
    const split = largestRemainder(amount, memberOrder.filter((m) => a.memberIds.includes(m)).map((m) => [m, 1]));
    for (const [m, v] of Object.entries(split ?? {})) member[m] = (member[m] ?? 0) + v;
  }
  return { totalFen: total, memberFen: member };
}

/** 数量守恒：每行顶层分配数量之和等于购买数量；无组件路径时不重复计费 */
export function conservationErrors(items: OrderItem[], assignments: Assignment[]): string[] {
  const errs: string[] = [];
  const lines = new Set(items.map((i) => i.lineId));
  for (const a of assignments) if (!lines.has(a.lineId)) errs.push(`分配引用了不存在的行 ${a.lineId}`);
  for (const i of items) {
    const top = assignments.filter((a) => a.lineId === i.lineId && !a.componentPath);
    const sum = top.reduce((s, a) => s + a.quantity, 0);
    if (sum !== i.quantity) errs.push(`行 ${i.lineId} 购买 ${i.quantity} 份，分配 ${sum} 份`);
  }
  return errs;
}
