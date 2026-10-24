import { describe, expect, it } from "vitest";
import { createSession, saveMembers, updateSession } from "@/modules/intake/session";
import { getPlanningContext, refreshCatalog, searchStores, selectStore } from "@/modules/catalog/store";
import { confirmFact } from "@/modules/catalog/facts";
import { defaultSelectionSummary, displayName, normalizeMeals } from "@/modules/catalog/normalize";
import { makeDeps, sixMembers } from "./helpers";
import { MOCK_MEALS } from "../fixtures/intake/mcp-responses";

const base = { mode: "mock" as const, name: "共学聚餐", memberCount: 6, budget: { kind: "total" as const, yuan: "150" } };

async function ready() {
  const ctx = makeDeps();
  const s = await createSession(ctx.deps, { ...base, city: "上海市", keyword: "人民广场" });
  await searchStores(ctx.deps, s.id);
  const sel = await selectStore(ctx.deps, s.id, "90000001", s.revision);
  const { session } = await refreshCatalog(ctx.deps, s.id, sel.revision, { detailCodes: ["MOCK-COMBO"] });
  const m = await saveMembers(ctx.deps, s.id, sixMembers(), session.revision);
  return { ...ctx, id: s.id, rev: m.session.revision };
}

describe("点餐局与成员", () => {
  it("人均预算换算为总分", async () => {
    const { deps } = makeDeps();
    const s = await createSession(deps, { ...base, budget: { kind: "perPerson", yuan: "25" } });
    expect(s.budgetFen).toBe(15000);
  });

  it("人数超出 6—20 被拒绝", async () => {
    const { deps } = makeDeps();
    await expect(createSession(deps, { ...base, memberCount: 5 })).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("旧 revision 写入返回 409", async () => {
    const { deps } = makeDeps();
    const s = await createSession(deps, base);
    await updateSession(deps, s.id, { name: "新名字" }, s.revision);
    await expect(updateSession(deps, s.id, { name: "又改" }, s.revision)).rejects.toMatchObject({ code: "STALE_REVISION", status: 409 });
  });

  it("成员数量与人数不一致被拒绝", async () => {
    const { deps } = makeDeps();
    const s = await createSession(deps, base);
    await expect(saveMembers(deps, s.id, sixMembers().slice(0, 5), s.revision)).rejects.toMatchObject({ code: "NEEDS_USER_INPUT" });
  });

  it("成员代号重复被拒绝", async () => {
    const { deps } = makeDeps();
    const s = await createSession(deps, base);
    const list = sixMembers();
    list[1]!.alias = list[0]!.alias;
    await expect(saveMembers(deps, s.id, list, s.revision)).rejects.toThrow(/重复/);
  });
});

describe("门店选择", () => {
  it("没有城市/位置时不触发搜索", async () => {
    const { deps, tools } = makeDeps();
    const s = await createSession(deps, base);
    await expect(searchStores(deps, s.id)).rejects.toMatchObject({ code: "NEEDS_USER_INPUT" });
    expect(tools.calls).toHaveLength(0);
  });

  it("搜索参数为到店自取，且不发送 beCode", async () => {
    const { deps, tools } = makeDeps();
    const s = await createSession(deps, { ...base, city: "上海市", keyword: "人民广场" });
    const { stores, warnings } = await searchStores(deps, s.id);
    expect(tools.calls[0]).toEqual({ tool: "queryNearbyStores", args: { beType: 1, searchType: 2, city: "上海市", keyword: "人民广场" } });
    expect(stores.map((x) => x.storeCode)).toEqual(["90000001", "90000002"]);
    expect(warnings.some((w) => w.includes("非数字"))).toBe(true);
  });

  it("未选门店不能获取菜单", async () => {
    const { deps, tools } = makeDeps();
    const s = await createSession(deps, base);
    await expect(refreshCatalog(deps, s.id, s.revision)).rejects.toMatchObject({ code: "NEEDS_USER_INPUT" });
    expect(tools.calls).toHaveLength(0);
  });

  it("不能选择搜索结果以外的门店", async () => {
    const { deps } = makeDeps();
    const s = await createSession(deps, { ...base, city: "上海市", keyword: "人民广场" });
    await searchStores(deps, s.id);
    await expect(selectStore(deps, s.id, "12345678", s.revision)).rejects.toMatchObject({ code: "NEEDS_USER_INPUT" });
  });

  it("换门店会清空菜单和事实确认，并通知下游失效", async () => {
    const { deps, repo, invalidations, id, rev } = await ready();
    await confirmFact(deps, id, { subjectId: "MOCK-BURGER-MILD", attribute: "contains_spicy", value: false, basis: "门店店员口头确认", confirmedBy: "组织者" }, rev);
    const s = (await repo.getSession(id))!;
    await selectStore(deps, id, "90000002", s.revision);
    expect(await repo.getMenuSnapshot(id)).toBeNull();
    expect(await repo.getFactConfirmations(id)).toEqual([]);
    expect(invalidations.at(-1)).toMatchObject({ reason: "store_changed" });
    await expect(getPlanningContext(deps, id)).rejects.toMatchObject({ code: "NEEDS_USER_INPUT" });
  });

  it("刷新后状态从仓库恢复一致", async () => {
    const { deps, id } = await ready();
    const a = await getPlanningContext(deps, id);
    const b = await getPlanningContext(deps, id);
    expect(b).toEqual(a);
  });
});

describe("菜单与事实", () => {
  it("菜单请求只含到店上下文", async () => {
    const { tools } = await ready();
    const mealCall = tools.calls.find((c) => c.tool === "queryMeals")!;
    expect(mealCall.args).toEqual({ beType: 1, orderType: 1, storeCode: "90000001" });
    for (const c of tools.calls) {
      for (const k of ["beCode", "reservationDate", "gmServiceCode", "addressId"]) expect(c.args).not.toHaveProperty(k);
    }
  });

  it("价格单位未核实时 priceFen 为 null 而不是 0", () => {
    const r = normalizeMeals(MOCK_MEALS, "s", null);
    expect(r.items.every((i) => i.priceFen === null)).toBe(true);
    expect(r.warnings.some((w) => w.includes("价格单位未核实"))).toBe(true);
    expect(normalizeMeals(MOCK_MEALS, "s", "fen").items[0]!.priceFen).toBe(2300);
    expect(normalizeMeals({ meals: [{ code: "A", name: "a", price: "12.5" }] }, "s", "yuan").items[0]!.priceFen).toBe(1250);
  });

  it("不从分类名或商品名推断主食", () => {
    const items = normalizeMeals(MOCK_MEALS, "s", null).items;
    expect(items.find((i) => i.code === "MOCK-BURGER")!.category).toBe("unknown");
    expect(items.find((i) => i.code === "MOCK-BURGER")!.toolCategoryName).toBe("汉堡");
    expect(items.find((i) => i.code === "MOCK-COMBO")!.category).toBe("combo");
  });

  it("名称含“无糖”也只是待确认", async () => {
    const { deps, id } = await ready();
    const ctx = await getPlanningContext(deps, id);
    const zero = ctx.facts.find((f) => f.subjectId === "MOCK-ZERO" && f.attribute === "is_sugary_drink")!;
    expect(zero.status).toBe("pending");
    expect(zero.value).toBeNull();
  });

  it("PlanningContext 只包含成员需要的属性", async () => {
    const { deps, id } = await ready();
    const ctx = await getPlanningContext(deps, id);
    expect(new Set(ctx.facts.map((f) => f.attribute))).toEqual(new Set(["is_main", "contains_spicy", "is_sugary_drink"]));
    expect(ctx.menu.coupons).toHaveLength(1);
    expect(ctx.totalBudgetFen).toBe(15000);
  });

  it("用户确认记为 user_confirmed，并使下游失效", async () => {
    const { deps, id, rev, invalidations } = await ready();
    const f = await confirmFact(deps, id, { subjectId: "MOCK-BURGER-MILD", attribute: "contains_spicy", value: false, basis: "看过门店配料牌", confirmedBy: "组织者" }, rev);
    expect(f.status).toBe("user_confirmed");
    expect(invalidations.at(-1)).toMatchObject({ reason: "fact_confirmed" });
    const ctx = await getPlanningContext(deps, id);
    expect(ctx.facts.find((x) => x.id === f.id)!.status).toBe("user_confirmed");
  });

  it("确认菜单外商品被拒绝", async () => {
    const { deps, id, rev } = await ready();
    await expect(
      confirmFact(deps, id, { subjectId: "NOPE", attribute: "is_main", value: true, basis: "随便", confirmedBy: "组织者" }, rev),
    ).rejects.toMatchObject({ code: "MENU_CHANGED" });
  });

  it("券查询失败不阻塞菜单，并给出提示", async () => {
    const { deps, tools } = makeDeps();
    tools.fail.add("queryStoreCoupons");
    const s = await createSession(deps, { ...base, city: "上海市", keyword: "人民广场" });
    await searchStores(deps, s.id);
    const sel = await selectStore(deps, s.id, "90000001", s.revision);
    const r = await refreshCatalog(deps, s.id, sel.revision);
    expect(r.snapshot.coupons).toEqual([]);
    expect(r.warnings.some((w) => w.includes("可用券查询失败"))).toBe(true);
  });

  it("菜单查询失败抛 MCP_ERROR，可重试", async () => {
    const { deps, tools } = makeDeps();
    tools.fail.add("queryMeals");
    const s = await createSession(deps, { ...base, city: "上海市", keyword: "人民广场" });
    await searchStores(deps, s.id);
    const sel = await selectStore(deps, s.id, "90000001", s.revision);
    await expect(refreshCatalog(deps, s.id, sel.revision)).rejects.toMatchObject({ code: "MCP_ERROR", retryable: true });
  });

  it("套餐详情：可特调标注与默认搭配摘要", async () => {
    const { deps, id } = await ready();
    const d = (await getPlanningContext(deps, id)).menu.details["MOCK-COMBO"]!;
    expect(displayName(d.name, d.supportModify)).toBe("模拟双人餐【可特调】");
    expect(defaultSelectionSummary(d)).toEqual(["主食：模拟香辣鸡腿堡【可特调】", "饮料：模拟可乐"]);
  });
});
