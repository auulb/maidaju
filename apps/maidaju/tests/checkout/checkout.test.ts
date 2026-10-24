import { describe, expect, it } from "vitest";
import { buildCreateOrderArgs, buildPriceArgs, cartHash } from "@/modules/checkout/params";
import { buildModification } from "@/modules/checkout/modification";
import { allocateMembers, largestRemainder } from "@/modules/checkout/allocation";
import { AppError } from "@/server/errors";
import { confirm, makeSnapshot, setup } from "./fixtures";

const code = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return (e as AppError).code; }
  return "NO_ERROR";
};

describe("参数构建", () => {
  it("到店请求不含 beCode 等条件字段，也不含本地 lineId", () => {
    const args = buildCreateOrderArgs(makeSnapshot(), "TW");
    const json = JSON.stringify(args);
    for (const k of ["beCode", "reservationDate", "gmServiceCode", "addressId", "lineId"]) expect(json).not.toContain(k);
    expect(args).toMatchObject({ storeCode: "1450001", orderType: 1, beType: 1, takeWayCode: "TW" });
  });

  it("context 里混入 beCode 直接拒绝", () => {
    const s = makeSnapshot({ context: { beType: 1, orderType: 1, storeCode: "1", beCode: "" } as any });
    expect(() => buildPriceArgs(s)).toThrow();
  });

  it("cartHash 对数量/餐具/券敏感，对分配不敏感", () => {
    const base = makeSnapshot();
    const h = cartHash(base);
    expect(cartHash(makeSnapshot({ needTableware: true }))).not.toBe(h);
    expect(cartHash(makeSnapshot({ items: [{ lineId: "L1", productCode: "MOCK-BURGER", quantity: 3 }] }))).not.toBe(h);
    expect(cartHash(makeSnapshot({ assignments: [] }))).toBe(h);
  });
});

describe("特调序列化", () => {
  const detail = {
    detailSnapshotId: "D1",
    options: [
      { code: "ICE", selectedKey: "ice_on", unselectedKey: "ice_off" },
      { code: "SAUCE", selectedKey: "sauce_on", unselectedKey: null },
    ],
  };
  it("未选中项的 unselectedKey 不遗漏", () => {
    expect(buildModification(detail, {})).toEqual({ values: [{ code: "ICE", key: "ice_off", quantity: 1 }] });
    expect(buildModification(detail, { ICE: 1, SAUCE: 2 })!.values).toEqual([
      { code: "ICE", key: "ice_on", quantity: 1 },
      { code: "SAUCE", key: "sauce_on", quantity: 2 },
    ]);
  });
  it("详情快照外的特调项拒绝", () => {
    expect(() => buildModification(detail, { GHOST: 1 })).toThrow(/不在当前详情快照/);
  });
});

describe("分摊", () => {
  it("最大余数法守恒，尾差按成员顺序", () => {
    expect(largestRemainder(100, [["a", 1], ["b", 1], ["c", 1]])).toEqual({ a: 34, b: 33, c: 33 });
  });
  it("共享项均摊 + 订单级优惠按比例，合计等于实付", () => {
    const s = makeSnapshot();
    const r = allocateMembers(s, { L1: 4600, L2: 1100 }, 5000)!;
    expect(Object.values(r).reduce((a, b) => a + b, 0)).toBe(5000);
    expect(r.a! - r.b!).toBe(1); // 尾差 1 分按成员顺序给 a
    expect(r.c).toBeLessThan(r.a!);
  });
  it("分配数量不守恒时返回 null（待确认）", () => {
    const s = makeSnapshot({ assignments: [{ lineId: "L1", memberIds: ["a"], quantity: 1, shared: false }] });
    expect(allocateMembers(s, { L1: 4600, L2: 1100 }, 5700)).toBeNull();
  });
});

describe("核价 → 确认 → 下单", () => {
  it("正常链路：看价格不触发下单，确认后只创建一次", async () => {
    const { svc, creates } = await setup();
    const q = await svc.quote("C1", 1);
    expect(q).toMatchObject({ status: "verified", payableFen: 5700, budgetOk: "pass" });
    expect(creates()).toBe(0);
    const a = await svc.authorize({ quoteId: q.id, ...confirm });
    const r = await svc.createOrder(a.id, "k1");
    expect(r.attempt.status).toBe("succeeded");
    expect(r.order!.orderId).toMatch(/^MOCK-ORDER-/);
    expect(r.order!.serverStatus).toBeNull(); // 创建成功 ≠ 已支付
    expect(creates()).toBe(1);
  });

  it("未明确确认不能授权", async () => {
    const { svc } = await setup();
    const q = await svc.quote("C1", 1);
    expect(await code(svc.authorize({ quoteId: q.id, ...confirm, userConfirmed: false }))).toBe("NEEDS_USER_INPUT");
  });

  it("取餐方式必须来自最新核价", async () => {
    const { svc } = await setup();
    const q = await svc.quote("C1", 1);
    expect(await code(svc.authorize({ quoteId: q.id, ...confirm, takeWayCode: "OLD" }))).toBe("NEEDS_USER_INPUT");
  });

  it("双击 / 并发只发一次远程创建", async () => {
    const { svc, creates } = await setup();
    const q = await svc.quote("C1", 1);
    const a = await svc.authorize({ quoteId: q.id, ...confirm });
    const [r1, r2] = await Promise.all([svc.createOrder(a.id, "k"), svc.createOrder(a.id, "k")]);
    expect(creates()).toBe(1);
    expect(r1.attempt.id).toBe(r2.attempt.id);
    const r3 = await svc.createOrder(a.id, "k");
    expect(r3.order!.orderId).toBe(r1.order?.orderId ?? r2.order?.orderId);
    expect(creates()).toBe(1);
  });

  it("超时 → outcome_unknown，冻结，不自动重试", async () => {
    const { svc, mock, creates } = await setup();
    const q = await svc.quote("C1", 1);
    const a = await svc.authorize({ quoteId: q.id, ...confirm });
    mock.failNextCreateWith = "timeout";
    expect(await code(svc.createOrder(a.id, "k"))).toBe("ORDER_OUTCOME_UNKNOWN");
    expect(await code(svc.createOrder(a.id, "k"))).toBe("ORDER_OUTCOME_UNKNOWN");
    expect(creates()).toBe(1);
  });

  it("候选修改后旧授权不能下单", async () => {
    const { svc, snapshots, creates } = await setup();
    const q = await svc.quote("C1", 1);
    const a = await svc.authorize({ quoteId: q.id, ...confirm });
    snapshots.put(makeSnapshot({ candidateVersion: 2, items: [{ lineId: "L1", productCode: "MOCK-BURGER", quantity: 3 }], assignments: [] }));
    expect(await code(svc.createOrder(a.id, "k"))).toBe("STALE_REVISION");
    expect(creates()).toBe(0);
  });

  it("失效钩子使报价和授权作废", async () => {
    const { svc, creates } = await setup();
    const q = await svc.quote("C1", 1);
    const a = await svc.authorize({ quoteId: q.id, ...confirm });
    await svc.invalidate("S1");
    expect(await code(svc.createOrder(a.id, "k"))).toBe("AUTH_INVALID");
    expect(creates()).toBe(0);
  });

  it("超出本地报价窗口需重新核价", async () => {
    const { svc, clock } = await setup();
    const q = await svc.quote("C1", 1);
    const a = await svc.authorize({ quoteId: q.id, ...confirm });
    clock.advance(3 * 60_000 + 1);
    expect(await code(svc.createOrder(a.id, "k"))).toBe("QUOTE_STALE");
  });

  it("实付超预算拒绝授权", async () => {
    const { svc } = await setup(makeSnapshot({ totalBudgetFen: 5000 }));
    const q = await svc.quote("C1", 1);
    expect(q.budgetOk).toBe("fail");
    expect(await code(svc.authorize({ quoteId: q.id, ...confirm }))).toBe("BUDGET_EXCEEDED");
  });

  it("未确认事实必须逐项接受", async () => {
    const { svc } = await setup(makeSnapshot({ hardConstraintStatus: "pending", unresolvedFactIds: ["F1"] }));
    const q = await svc.quote("C1", 1);
    expect(await code(svc.authorize({ quoteId: q.id, ...confirm }))).toBe("FACT_PENDING");
    const a = await svc.authorize({ quoteId: q.id, ...confirm, acknowledgedFactIds: ["F1"] });
    expect(a.acknowledgedFactIds).toEqual(["F1"]);
  });

  it("明确冲突的候选不能核价", async () => {
    const { svc } = await setup(makeSnapshot({ hardConstraintStatus: "fail" }));
    expect(await code(svc.quote("C1", 1))).toBe("CONSTRAINT_FAILED");
  });

  it("模拟快照不能走真实 transport", async () => {
    const { svc } = await setup(makeSnapshot({ mode: "live" }));
    expect(await code(svc.quote("C1", 1))).toBe("MODE_MISMATCH");
  });

  it("服务端拒单 → rejected，不保存订单", async () => {
    const { svc, mock } = await setup();
    const q = await svc.quote("C1", 1);
    const a = await svc.authorize({ quoteId: q.id, ...confirm });
    mock.failNextCreateWith = "reject";
    const r = await svc.createOrder(a.id, "k");
    expect(r.attempt.status).toBe("rejected");
    expect(r.order).toBeNull();
  });

  it("支付反馈后查询服务端状态，而不是本地改为已支付", async () => {
    const { svc, mock } = await setup();
    const q = await svc.quote("C1", 1);
    const a = await svc.authorize({ quoteId: q.id, ...confirm });
    const { order } = await svc.createOrder(a.id, "k");
    const o = await svc.refreshOrder(order!.orderId);
    expect(o.serverStatus).toBe("待支付（模拟）");
    expect(mock.calls.at(-1)!.name).toBe("query-order");
  });

  it("重启时 sending 记录转为 outcome_unknown", async () => {
    const { svc, repo } = await setup();
    const q = await svc.quote("C1", 1);
    const a = await svc.authorize({ quoteId: q.id, ...confirm });
    await repo.claimAttempt({ id: "X", authorizationId: a.id, idempotencyKey: "k", requestDigest: "", status: "sending", orderId: null, error: null, createdAt: "", updatedAt: "" });
    expect(await svc.recoverStuckAttempts()).toBe(1);
    expect(await code(svc.createOrder(a.id, "k"))).toBe("ORDER_OUTCOME_UNKNOWN");
  });
});
