// 金额分摊：整数分 + 最大余数法，尾差按固定成员顺序。保证 sum === total。
import type { CheckoutSnapshot, Fen } from "@/contracts";

/** 按权重分配 total；权重全为 0 时返回 null（无法分配） */
export function largestRemainder(total: Fen, weights: [string, number][]): Record<string, Fen> | null {
  const W = weights.reduce((s, [, w]) => s + w, 0);
  if (W <= 0) return null;
  const rows = weights.map(([id, w], idx) => {
    const exact = (total * w) / W;
    return { id, idx, floor: Math.floor(exact), rem: exact - Math.floor(exact) };
  });
  let left = total - rows.reduce((s, r) => s + r.floor, 0);
  const order = [...rows].sort((a, b) => b.rem - a.rem || a.idx - b.idx);
  for (const r of order) {
    if (left <= 0) break;
    r.floor += 1;
    left -= 1;
  }
  return Object.fromEntries(rows.map((r) => [r.id, r.floor]));
}

/**
 * lineAmountsFen: lineId -> 优惠前行金额（来自服务端）。
 * 先把每行金额按分配数量拆给成员（共享项均摊），得到成员优惠前金额；
 * 再按该比例分配实付 payableFen（覆盖订单级优惠）。
 */
export function allocateMembers(s: CheckoutSnapshot, lineAmountsFen: Record<string, Fen> | null, payableFen: Fen): Record<string, Fen> | null {
  if (!lineAmountsFen) return null;
  const pre: Record<string, number> = Object.fromEntries(s.memberIds.map((m) => [m, 0]));
  for (const item of s.items) {
    const amount = lineAmountsFen[item.lineId];
    if (amount == null) return null;
    // 只按顶层（无 componentPath）分配计算金额，组件分配不重复计费
    const top = s.assignments.filter((a) => a.lineId === item.lineId && !a.componentPath);
    const assignedQty = top.reduce((q, a) => q + a.quantity, 0);
    if (assignedQty !== item.quantity) return null; // 数量不守恒：无法可靠分摊
    const perAssignment = largestRemainder(amount, top.map((a, i) => [String(i), a.quantity]));
    if (!perAssignment) return null;
    top.forEach((a, i) => {
      const part = perAssignment[String(i)]!;
      const split = largestRemainder(part, s.memberIds.filter((m) => a.memberIds.includes(m)).map((m) => [m, 1]));
      if (!split) return;
      for (const [m, v] of Object.entries(split)) pre[m] = (pre[m] ?? 0) + v;
    });
  }
  return largestRemainder(payableFen, s.memberIds.map((m) => [m, pre[m] ?? 0]));
}

export function checkBudgets(
  s: CheckoutSnapshot,
  payableFen: Fen,
  allocated: Record<string, Fen> | null,
): { status: "pass" | "pending" | "fail"; violations: string[] } {
  const violations: string[] = [];
  if (s.totalBudgetFen != null && payableFen > s.totalBudgetFen) violations.push(`整局实付 ${payableFen} 分超出预算 ${s.totalBudgetFen} 分`);
  const caps = Object.entries(s.memberBudgetCapFen).filter(([, c]) => c != null) as [string, Fen][];
  let pending = false;
  if (caps.length) {
    if (!allocated) pending = true;
    else {
      const sum = Object.values(allocated).reduce((a, b) => a + b, 0);
      if (sum !== payableFen) pending = true;
      for (const [m, cap] of caps) {
        const v = allocated[m];
        if (v == null) pending = true;
        else if (v > cap) violations.push(`成员 ${m} 分摊 ${v} 分超出上限 ${cap} 分`);
      }
    }
  }
  return { status: violations.length ? "fail" : pending ? "pending" : "pass", violations };
}
