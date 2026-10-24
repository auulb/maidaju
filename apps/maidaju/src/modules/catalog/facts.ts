/**
 * A5：商品事实。默认全部 pending——菜单不提供辣度/糖分/主食字段时不算满足，也不判违反。
 * 名称里出现"无糖""香辣"等字样不产生任何事实。
 */
import { z } from "zod";
import { AppError } from "@/server/errors";
import type { IntakeDeps } from "../ports";
import { commitSession, loadSession } from "../intake/session";
import type { HardAvoid } from "../intake/types";
import { Fact, FactAttribute, type MenuSnapshot } from "./types";

export const AVOID_TO_ATTRIBUTE: Record<HardAvoid, FactAttribute> = {
  spicy: "contains_spicy",
  sugary_drink: "is_sugary_drink",
  beef: "contains_beef",
  pork: "contains_pork",
  seafood: "contains_seafood",
};

const factId = (snapshotId: string, subjectId: string, attr: FactAttribute) => `${snapshotId}:${subjectId}:${attr}`;

/** 合并：菜单快照中的商品 × 需要的属性；有确认记录则用确认，否则 pending */
export function deriveFacts(menu: MenuSnapshot, attributes: FactAttribute[], confirmations: Fact[]): Fact[] {
  const confirmed = new Map(
    confirmations.filter((f) => f.menuSnapshotId === menu.id).map((f) => [`${f.subjectId}:${f.attribute}`, f]),
  );
  const out: Fact[] = [];
  for (const item of menu.items) {
    for (const attr of new Set(attributes)) {
      const hit = confirmed.get(`${item.code}:${attr}`);
      out.push(
        hit ?? {
          id: factId(menu.id, item.code, attr),
          subjectId: item.code,
          attribute: attr,
          value: null,
          status: "pending",
          sourceRef: null,
          confirmedBy: null,
          basis: null,
          menuSnapshotId: menu.id,
          observedAt: menu.fetchedAt,
        },
      );
    }
  }
  return out;
}

export const ConfirmFactInput = z.object({
  subjectId: z.string().min(1),
  attribute: FactAttribute,
  value: z.boolean(),
  basis: z.string().trim().min(2).max(200),
  confirmedBy: z.string().trim().min(1).max(40),
});
export type ConfirmFactInput = z.infer<typeof ConfirmFactInput>;

/**
 * 用户确认某商品属性。记录为 user_confirmed（不冒充官方认证）；
 * 若与已有工具事实相反，标记 conflict 而不是覆盖。
 */
export async function confirmFact(deps: IntakeDeps, sessionId: string, input: ConfirmFactInput, expectedRevision: number): Promise<Fact> {
  const r = ConfirmFactInput.safeParse(input);
  if (!r.success) throw new AppError("VALIDATION", "确认内容不合法", false, r.error.issues);
  const p = r.data;
  const session = await loadSession(deps, sessionId);
  const menu = await deps.repo.getMenuSnapshot(sessionId);
  if (!menu) throw new AppError("NEEDS_USER_INPUT", "请先选择门店并获取菜单");
  if (!menu.items.some((i) => i.code === p.subjectId)) throw new AppError("MENU_CHANGED", `商品 ${p.subjectId} 不在当前菜单快照中`);

  const existing = await deps.repo.getFactConfirmations(sessionId);
  const prior = existing.find((f) => f.menuSnapshotId === menu.id && f.subjectId === p.subjectId && f.attribute === p.attribute);
  const conflict = prior?.status === "tool_supported" && prior.value !== p.value;

  const saved = await commitSession(deps, session, {}, expectedRevision);
  const fact: Fact = {
    id: factId(menu.id, p.subjectId, p.attribute),
    subjectId: p.subjectId,
    attribute: p.attribute,
    value: conflict ? prior!.value : p.value,
    status: conflict ? "conflict" : "user_confirmed",
    sourceRef: conflict ? prior!.sourceRef : null,
    confirmedBy: p.confirmedBy,
    basis: conflict ? `用户确认 ${p.value} 与工具值 ${String(prior!.value)} 相反：${p.basis}` : p.basis,
    menuSnapshotId: menu.id,
    observedAt: deps.now(),
  };
  const rest = existing.filter((f) => f.id !== fact.id);
  await deps.repo.replaceFactConfirmations(sessionId, [...rest, Fact.parse(fact)]);
  await deps.invalidation.invalidate(sessionId, "fact_confirmed", saved.revision);
  return fact;
}

export const FACT_STATUS_LABEL: Record<Fact["status"], { icon: string; text: string }> = {
  tool_supported: { icon: "✓", text: "工具证据支持" },
  user_confirmed: { icon: "✓", text: "用户确认" },
  pending: { icon: "?", text: "待确认" },
  conflict: { icon: "✗", text: "明确冲突" },
};
