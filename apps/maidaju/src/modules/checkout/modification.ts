// 特调序列化：选中项用 selectedKey；未选中项只要 unselectedKey 非空也必须传入。
import type { ModificationValue } from "@/contracts";
import { AppError } from "@/server/errors";

/** 由 AI-1 从 query-meal-detail 标准化得到的特调项 */
export type ModOption = {
  code: string;
  selectedKey: string;
  unselectedKey: string | null;
  minQuantity?: number;
  maxQuantity?: number;
};
export type ModDetail = { detailSnapshotId: string; options: ModOption[] };

/** userSelections: code -> 数量（0 或缺省表示未选） */
export function buildModification(detail: ModDetail, userSelections: Record<string, number>): { values: ModificationValue[] } | undefined {
  const byCode = new Map(detail.options.map((o) => [o.code, o]));
  for (const code of Object.keys(userSelections)) {
    if (!byCode.has(code)) throw new AppError("MENU_CHANGED", `特调项 ${code} 不在当前详情快照 ${detail.detailSnapshotId} 中`);
  }
  const values: ModificationValue[] = [];
  for (const o of detail.options) {
    const qty = userSelections[o.code] ?? 0;
    if (!Number.isInteger(qty) || qty < 0) throw new AppError("VALIDATION", `特调 ${o.code} 数量非法`);
    if (qty > 0) {
      if (o.maxQuantity != null && qty > o.maxQuantity) throw new AppError("VALIDATION", `特调 ${o.code} 超出上限 ${o.maxQuantity}`);
      if (o.minQuantity != null && qty < o.minQuantity) throw new AppError("VALIDATION", `特调 ${o.code} 低于下限 ${o.minQuantity}`);
      if (!o.selectedKey) throw new AppError("MENU_CHANGED", `特调 ${o.code} 缺少 selectedKey`);
      values.push({ code: o.code, key: o.selectedKey, quantity: qty });
    } else if (o.unselectedKey) {
      values.push({ code: o.code, key: o.unselectedKey, quantity: 1 });
    }
  }
  return values.length ? { values } : undefined;
}
