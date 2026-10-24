/**
 * A3/A4：门店搜索、明确选店、菜单与可用券快照、PlanningContext。
 * 首版到店自取：beType=1, orderType=1；任何请求都不发送 beCode / reservationDate / 地址。
 */
import { AppError } from "@/server/errors";
import type { DiningContext } from "@/contracts";
import type { IntakeDeps, ReadOnlyTool } from "../ports";
import { commitSession, loadSession } from "../intake/session";
import { MemberRequirement } from "../intake/types";
import { AVOID_TO_ATTRIBUTE, deriveFacts } from "./facts";
import { normalizeCoupons, normalizeMealDetail, normalizeMeals, normalizeStores, type PriceUnit } from "./normalize";
import { MenuSnapshot, PlanningContext, type FactAttribute, type StoreSummary } from "./types";

const FORBIDDEN_KEYS = ["beCode", "reservationDate", "gmServiceCode", "addressId"];

async function callReadOnly(deps: IntakeDeps, tool: ReadOnlyTool, args: Record<string, unknown>) {
  for (const k of FORBIDDEN_KEYS) if (k in args) throw new AppError("VALIDATION", `首版到店请求不允许字段 ${k}`);
  let r;
  try {
    r = await deps.tools.call(tool, args);
  } catch (e) {
    throw new AppError("MCP_ERROR", `${tool} 调用失败：${e instanceof Error ? e.message : "未知错误"}`, true);
  }
  if (!r.ok) throw new AppError("MCP_ERROR", `${tool} 返回失败：${r.message}`, true);
  return r.data;
}

export async function searchStores(deps: IntakeDeps, sessionId: string): Promise<{ stores: StoreSummary[]; warnings: string[] }> {
  const s = await loadSession(deps, sessionId);
  if (!s.city || !s.keyword) throw new AppError("NEEDS_USER_INPUT", "请先填写城市和位置关键词，系统不会自动定位");
  if (s.mode !== deps.tools.mode) throw new AppError("MODE_MISMATCH", `点餐局为 ${s.mode} 模式，当前 MCP 为 ${deps.tools.mode}`);
  const data = await callReadOnly(deps, "queryNearbyStores", { beType: 1, searchType: 2, city: s.city, keyword: s.keyword });
  const { items, warnings } = normalizeStores(data, s.mode, `stores@${deps.now()}`);
  await deps.repo.saveStoreSearch(sessionId, items);
  return { stores: items, warnings };
}

/** 用户明确选择门店：只能选最近一次搜索结果中的门店；换店清空菜单与事实确认，下游全部失效 */
export async function selectStore(deps: IntakeDeps, sessionId: string, storeCode: string, expectedRevision: number) {
  const s = await loadSession(deps, sessionId);
  const found = (await deps.repo.getStoreSearch(sessionId)).find((x) => x.storeCode === storeCode);
  if (!found) throw new AppError("NEEDS_USER_INPUT", "请从门店搜索结果中选择门店");
  if (found.mode !== s.mode) throw new AppError("MODE_MISMATCH", "门店来源模式与点餐局不一致");
  const changed = s.selectedStore?.storeCode !== storeCode;
  const saved = await commitSession(deps, s, { selectedStore: found }, expectedRevision);
  if (changed) {
    await deps.repo.saveMenuSnapshot(sessionId, null);
    await deps.repo.replaceFactConfirmations(sessionId, []);
  }
  await deps.invalidation.invalidate(sessionId, "store_changed", saved.revision);
  return saved;
}

export type RefreshOptions = {
  /** 需要拉详情（套餐轮次/特调）的商品，最多 30 个 */
  detailCodes?: string[];
  /** 菜单价格单位，真实接口核实前保持 null */
  priceUnit?: PriceUnit;
};

export async function refreshCatalog(deps: IntakeDeps, sessionId: string, expectedRevision: number, opts: RefreshOptions = {}) {
  const s = await loadSession(deps, sessionId);
  if (!s.selectedStore) throw new AppError("NEEDS_USER_INPUT", "请先明确选择门店");
  if (s.mode !== deps.tools.mode) throw new AppError("MODE_MISMATCH", `点餐局为 ${s.mode} 模式，当前 MCP 为 ${deps.tools.mode}`);
  if (s.revision !== expectedRevision) throw new AppError("STALE_REVISION", "点餐局已被修改，请刷新后重试");

  const context: DiningContext = { beType: 1, orderType: 1, storeCode: s.selectedStore.storeCode };
  const snapshotId = deps.newId();
  const fetchedAt = deps.now();
  const warnings: string[] = [];

  const meals = normalizeMeals(await callReadOnly(deps, "queryMeals", { ...context }), `${snapshotId}/meals`, opts.priceUnit ?? null);
  warnings.push(...meals.warnings);
  let coupons: ReturnType<typeof normalizeCoupons> = { items: [], warnings: [] };
  try {
    coupons = normalizeCoupons(await callReadOnly(deps, "queryStoreCoupons", { ...context }), `${snapshotId}/coupons`);
  } catch (e) {
    warnings.push(`可用券查询失败，暂不使用优惠券：${e instanceof Error ? e.message : ""}`);
  }

  const known = new Set(meals.items.map((i) => i.code));
  const details: MenuSnapshot["details"] = {};
  for (const code of (opts.detailCodes ?? []).slice(0, 30)) {
    if (!known.has(code)) {
      warnings.push(`商品 ${code} 不在当前菜单，跳过详情`);
      continue;
    }
    try {
      const raw = await callReadOnly(deps, "queryMealDetail", { ...context, code });
      details[code] = normalizeMealDetail(raw, code, `${snapshotId}/detail/${code}`, fetchedAt);
    } catch (e) {
      warnings.push(`商品 ${code} 详情获取失败`);
    }
  }

  // 刷新菜单本身改变下游依据：递增 revision 并失效候选/报价
  const saved = await commitSession(deps, s, {}, expectedRevision);
  const snapshot = MenuSnapshot.parse({
    id: snapshotId,
    mode: s.mode,
    context,
    items: meals.items,
    coupons: coupons.items,
    details,
    fetchedAt,
    sessionRevision: saved.revision,
  });
  await deps.repo.saveMenuSnapshot(sessionId, snapshot);
  await deps.invalidation.invalidate(sessionId, "menu_refreshed", saved.revision);
  return { session: saved, snapshot, warnings };
}

/** AI-1 -> AI-2 交接：只返回已确认的成员需求与带来源的目录；任何前置缺失都报错而不是补默认值 */
export async function getPlanningContext(deps: IntakeDeps, sessionId: string): Promise<PlanningContext> {
  const s = await loadSession(deps, sessionId);
  if (!s.selectedStore) throw new AppError("NEEDS_USER_INPUT", "尚未选择门店");
  const menu = await deps.repo.getMenuSnapshot(sessionId);
  if (!menu) throw new AppError("NEEDS_USER_INPUT", "尚未获取菜单");
  if (menu.context.storeCode !== s.selectedStore.storeCode || menu.mode !== s.mode) {
    throw new AppError("MENU_CHANGED", "菜单快照与当前门店/模式不一致，请重新获取");
  }
  const members = (await deps.repo.getMembers(sessionId)).map((m) => MemberRequirement.parse(m));
  if (members.length !== s.memberCount) {
    throw new AppError("NEEDS_USER_INPUT", `已确认成员 ${members.length} 人，点餐局为 ${s.memberCount} 人`);
  }
  const attrs: FactAttribute[] = ["is_main", ...members.flatMap((m) => m.hardAvoid.map((h) => AVOID_TO_ATTRIBUTE[h]))];
  const facts = deriveFacts(menu, attrs, await deps.repo.getFactConfirmations(sessionId));
  return PlanningContext.parse({
    sessionId,
    sessionRevision: s.revision,
    mode: s.mode,
    totalBudgetFen: s.budgetFen,
    memberCount: s.memberCount,
    needTableware: s.needTableware,
    members,
    menu,
    facts,
  });
}
