import { describe, expect, it } from "vitest";
import { CheckoutSnapshot } from "@/contracts";
import { AppError } from "@/server/errors";
import { MockMcpTransport } from "@/server/mcp/mock";
import { ToolRegistry } from "@/server/mcp/transport";
import { MemoryCheckoutRepo } from "@/modules/checkout/repo";
import { CheckoutService } from "@/modules/checkout/service";
import { buildPlanCatalog } from "@/modules/planning/catalog";
import { conservationErrors } from "@/modules/planning/build";
import { explainCandidate, validateExplanation } from "@/modules/planning/explain";
import { validatePricedCandidate } from "@/modules/planning/service";
import type { Candidate } from "@/modules/planning/types";
import { ctx, fact, sixMembers, service, stdFacts, STD_ITEMS } from "./fixtures";

const MAINS = new Set(["MOCK-BURGER", "MOCK-BURGER-MILD", "MOCK-WRAP"]);
const sortKey = (c: Candidate) => JSON.stringify(c.items.map((i) => [i.productCode, i.quantity]).sort());

function assertCandidateInvariants(c: Candidate) {
  expect(conservationErrors(c.items, c.assignments)).toEqual([]);
  // 不吃辣成员不分到香辣堡；不喝含糖饮料成员不分到可乐（含共享）
  for (const a of c.assignments) {
    const code = c.items.find((i) => i.lineId === a.lineId)!.productCode;
    if (code === "MOCK-BURGER") expect(a.memberIds.some((m) => m === "m1" || m === "m2")).toBe(false);
    if (code === "MOCK-COLA") expect(a.memberIds).not.toContain("m3");
  }
  // 每人至少一份独享主食，主食不重复分配
  for (const m of c.memberOrder) expect(c.trays[m]!.filter((x) => MAINS.has(x)).length).toBeGreaterThanOrEqual(1);
  for (const s of c.shared) expect(MAINS.has(s.code)).toBe(false);
}

describe("B1 目录与约束检查", () => {
  it("名称不产生事实：无事实时主食为 unknown、辣度 pending", () => {
    const { items } = buildPlanCatalog(ctx({ facts: [] }));
    const burger = items.find((i) => i.code === "MOCK-BURGER")!;
    expect(burger.main.status).toBe("unknown");
    expect(burger.avoid.contains_spicy!.status).toBe("pending");
    const zero = items.find((i) => i.code === "MOCK-ZERO")!;
    expect(zero.avoid.is_sugary_drink!.status).toBe("pending"); // “无糖”字样不算满足
  });

  it("工具分类 side/drink 只能排除主食，不能确认主食", () => {
    const { items } = buildPlanCatalog(ctx({ facts: [] }));
    expect(items.find((i) => i.code === "MOCK-FRIES")!.main.status).toBe("no");
    expect(items.find((i) => i.code === "MOCK-WRAP")!.main.status).toBe("unknown");
  });

  it("conflict 事实视为违反", () => {
    const facts = stdFacts().map((f) => (f.subjectId === "MOCK-WRAP" && f.attribute === "contains_spicy" ? { ...f, status: "conflict" as const } : f));
    const { items } = buildPlanCatalog(ctx({ facts }));
    expect(items.find((i) => i.code === "MOCK-WRAP")!.avoid.contains_spicy!.status).toBe("fail");
  });

  it("套餐缺详情不可构建；有唯一默认项时构建 roundList", () => {
    const items = [...STD_ITEMS, { code: "MOCK-COMBO", name: "模拟套餐", priceFen: 3000, category: "combo" as const }, { code: "MOCK-COMBO2", name: "模拟套餐2", priceFen: 3000, category: "combo" as const }];
    const detail = {
      code: "MOCK-COMBO2", name: "模拟套餐2", supportModify: false, raw: null, sourceRef: "mock", fetchedAt: "x",
      rounds: [{ round: "1", name: "主食", choices: [{ code: "MOCK-WRAP", name: "卷", isDefault: true, supportModify: false }, { code: "MOCK-BURGER", name: "堡", isDefault: false, supportModify: false }] }],
    };
    const { items: plan } = buildPlanCatalog(ctx({ items, details: { "MOCK-COMBO2": detail } }));
    expect(plan.find((i) => i.code === "MOCK-COMBO")!.buildable).toBe(false);
    const c2 = plan.find((i) => i.code === "MOCK-COMBO2")!;
    expect(c2.buildable).toBe(true);
    expect(c2.roundList).toEqual([{ round: "1", comboItemList: [{ code: "MOCK-WRAP", quantity: 1 }] }]);
  });
});

describe("B2 候选生成", () => {
  it("可行输入：至少两套真正不同的候选，约束全部 pass，价格标注为估算", async () => {
    const { svc } = service();
    const r = await svc.generate(ctx());
    expect(r.candidates.length).toBeGreaterThanOrEqual(2);
    expect(new Set(r.candidates.map(sortKey)).size).toBe(r.candidates.length);
    for (const c of r.candidates) {
      expect(c.hardConstraintStatus).toBe("pass");
      expect(c.priceSource).toBe("estimate");
      expect(c.estimatedTotalFen!).toBeLessThanOrEqual(24000);
      expect(Object.values(c.estimatedMemberFen!).reduce((a, b) => a + b, 0)).toBe(c.estimatedTotalFen);
      assertCandidateInvariants(c);
    }
  });

  it("未知事实：候选为 pending 并列出未决事实，绝不判 pass", async () => {
    const { svc } = service();
    const r = await svc.generate(ctx({ facts: [] }));
    expect(r.candidates.length).toBeGreaterThan(0);
    for (const c of r.candidates) {
      expect(c.hardConstraintStatus).toBe("pending");
      expect(c.unresolvedFactIds.length).toBeGreaterThan(0);
      expect(c.checks.some((x) => x.constraint === "required_main" && x.status === "pending")).toBe(true);
      // 每个 pending 检查都带可被 AI-3 闸门拦截的事实 ID
      for (const x of c.checks.filter((y) => y.status === "pending" && y.constraint !== "total_budget")) expect(x.factIds.length).toBeGreaterThan(0);
    }
  });

  it("pending 候选未逐项接受事实时，AI-3 授权闸门拒绝（FACT_PENDING）", async () => {
    const members = sixMembers().map((m) => ({ ...m, hardAvoid: [] }));
    const items = [STD_ITEMS[0]!, STD_ITEMS[3]!, STD_ITEMS[5]!];
    const { svc } = service();
    const c = (await svc.generate(ctx({ members, items, budgetFen: 30000, facts: [] }))).candidates[0]!;
    expect(c.unresolvedFactIds).toContain("MENU-1:MOCK-BURGER:is_main");
    const mock = new MockMcpTransport();
    const tools = new ToolRegistry(mock);
    await tools.init();
    const checkout = new CheckoutService({ repo: new MemoryCheckoutRepo(), tools, snapshots: svc });
    const q = await checkout.quote(c.id, c.version);
    await expect(
      checkout.authorize({ quoteId: q.id, takeWayCode: "MOCK-TW-1", acknowledgedFactIds: [], organizerId: "org", userConfirmed: true }),
    ).rejects.toMatchObject({ code: "FACT_PENDING" });
    expect(mock.calls.some((x) => x.name === "create-order")).toBe(false);
  });

  it("预算不可行：冲突提示，不输出候选，不自动突破预算", async () => {
    const { svc } = service();
    const r = await svc.generate(ctx({ budgetFen: 5000 }));
    expect(r.candidates).toEqual([]);
    expect(r.conflicts[0]!.kind).toBe("total_budget");
    expect(r.message).toContain("当前搜索范围内未找到");
    expect(r.conflicts[0]!.suggestions).toContain("提高总预算");
  });

  it("仅有一解：如实输出 1 套，不复制凑数", async () => {
    const { svc } = service();
    const r = await svc.generate(ctx({ items: [STD_ITEMS[2]!, STD_ITEMS[5]!], facts: stdFacts() }));
    expect(r.candidates).toHaveLength(1);
    expect(r.message).toContain("只找到 1 套");
  });

  it("成员无可分配主食：给出该成员的冲突与修改建议", async () => {
    const members = sixMembers({ m1: { hardAvoid: ["spicy", "pork"] } });
    const facts = [...stdFacts(), fact("MOCK-WRAP", "contains_pork", true), fact("MOCK-BURGER-MILD", "contains_pork", true), fact("MOCK-BURGER", "contains_pork", false)];
    const { svc } = service();
    const r = await svc.generate(ctx({ members, facts }));
    expect(r.candidates).toEqual([]);
    expect(r.conflicts[0]).toMatchObject({ kind: "no_eligible_main", memberIds: ["m1"] });
  });

  it("缺少可靠价格：估算为 null（不填 0），预算检查为 pending", async () => {
    // 不吃辣成员只能选卷或板烧堡；两者都没有价格 → 所有候选都含无价商品
    const items = STD_ITEMS.map((i) => (i.code === "MOCK-WRAP" || i.code === "MOCK-BURGER-MILD" ? { ...i, priceFen: null } : i));
    const { svc } = service();
    const r = await svc.generate(ctx({ items }));
    expect(r.candidates.length).toBeGreaterThan(0);
    for (const c of r.candidates) {
      expect(c.estimatedTotalFen).toBeNull();
      expect(c.estimatedMemberFen).toBeNull();
      expect(c.priceSource).toBe("unknown");
      expect(c.checks.find((x) => x.constraint === "total_budget")!.status).toBe("pending");
    }
  });

  it("个人预算上限参与检查", async () => {
    const { svc } = service();
    const r = await svc.generate(ctx({ members: sixMembers({ m4: { budgetCapFen: 3000 } }) }));
    for (const c of r.candidates) {
      expect(c.estimatedMemberFen!.m4!).toBeLessThanOrEqual(3000);
      expect(c.checks.find((x) => x.memberId === "m4" && x.constraint === "member_budget")!.status).toBe("pass");
    }
  });

  it("重新生成会替代旧候选", async () => {
    const { svc } = service();
    const a = await svc.generate(ctx());
    await svc.generate(ctx());
    expect(await svc.getLatestVersion(a.candidates[0]!.id)).toBeNull();
  });

  it("6 人与 20 人基准：在搜索上限内完成并记录统计", async () => {
    for (const n of [6, 20]) {
      const members = Array.from({ length: n }, (_, i) => ({ ...sixMembers()[i % 6]!, memberId: `p${i}`, alias: `成员${i}` }));
      const { svc } = service();
      const started = performance.now();
      const r = await svc.generate(ctx({ members, budgetFen: n * 3000 }));
      const ms = performance.now() - started;
      console.log(`[bench] ${n} 人：${r.candidates.length} 套，nodes=${r.stats.nodes}，truncated=${r.stats.truncated}，wall=${ms.toFixed(1)}ms`);
      expect(r.candidates.length).toBeGreaterThanOrEqual(2);
      for (const c of r.candidates) expect(conservationErrors(c.items, c.assignments)).toEqual([]);
    }
  });
});

describe("B4 手工调整与局部重配", () => {
  it("手工调整生成新版本，旧版本失效；旧版本号再提交返回 STALE_REVISION", async () => {
    const { svc } = service();
    const c = (await svc.generate(ctx())).candidates[0]!;
    const v2 = await svc.applyManualEdit(ctx(), c.id, 1, { trays: { m4: ["MOCK-BURGER", "MOCK-FRIES"] } });
    expect(v2.version).toBe(2);
    expect(v2.changes).toEqual([{ memberId: "m4", reason: "组织者手工调整餐盘" }]);
    expect(await svc.getLatestVersion(c.id)).toBe(2);
    expect(await svc.getCheckoutSnapshot(c.id, 1)).toBeNull();
    await expect(svc.applyManualEdit(ctx(), c.id, 1, { trays: { m4: ["MOCK-WRAP"] } })).rejects.toMatchObject({ code: "STALE_REVISION" });
  });

  it("手工把香辣堡给不吃辣成员：候选为 fail，不能进入核价", async () => {
    const { svc } = service();
    const c = (await svc.generate(ctx())).candidates[0]!;
    const v2 = await svc.applyManualEdit(ctx(), c.id, 1, { trays: { m1: ["MOCK-BURGER"] } });
    expect(v2.hardConstraintStatus).toBe("fail");
    expect(v2.checks.find((x) => x.memberId === "m1" && x.constraint === "avoid:spicy")!.status).toBe("fail");
  });

  it("共享主食不计入个人最低主食要求", async () => {
    const { svc } = service();
    const c = (await svc.generate(ctx())).candidates[0]!;
    const v2 = await svc.applyManualEdit(ctx(), c.id, 1, { trays: { m5: [], m6: [] }, shared: [{ code: "MOCK-WRAP", quantity: 1, memberIds: ["m5", "m6"] }] });
    expect(v2.checks.find((x) => x.memberId === "m5" && x.constraint === "required_main")!.status).toBe("fail");
    expect(conservationErrors(v2.items, v2.assignments)).toEqual([]);
  });

  it("拒绝不在当前菜单的商品", async () => {
    const { svc } = service();
    const c = (await svc.generate(ctx())).candidates[0]!;
    await expect(svc.applyManualEdit(ctx(), c.id, 1, { trays: { m1: ["MOCK-GHOST"] } })).rejects.toBeInstanceOf(AppError);
  });

  it("修改一人：其他成员餐盘保持不变（无理由改动 = 0）", async () => {
    const { svc } = service();
    const c = (await svc.generate(ctx())).candidates[0]!;
    const next = ctx({ members: sixMembers({ m4: { requiredMainCount: 2 } }), revision: 1 });
    const r = await svc.replanAffectedMembers(next, c.id, 1, ["m4"]);
    expect(r.conflicts).toEqual([]);
    expect(r.changedMemberIds).toEqual(["m4"]);
    for (const m of ["m1", "m2", "m3", "m5", "m6"]) expect(r.candidate!.trays[m]).toEqual(c.trays[m]);
    expect(r.candidate!.trays.m4!.filter((x) => MAINS.has(x))).toHaveLength(2);
    expect(r.candidate!.changes.every((x) => x.memberId === "m4" || x.memberId === null)).toBe(true);
  });

  it("受影响成员原餐盘仍合法时不变动", async () => {
    const { svc } = service();
    const c = (await svc.generate(ctx())).candidates[0]!;
    const r = await svc.replanAffectedMembers(ctx(), c.id, 1, ["m4"]);
    expect(r.changedMemberIds).toEqual([]);
    expect(r.candidate!.trays).toEqual(c.trays);
  });

  it("事实变化导致未点名成员违反时，纳入重配并给出具体原因", async () => {
    const { svc } = service();
    const c = (await svc.generate(ctx({ budgetFen: 16800 }))).candidates[0]!;
    expect(c.trays.m1).toContain("MOCK-WRAP");
    const facts = stdFacts({ "MOCK-WRAP": { contains_spicy: true } });
    const r = await svc.replanAffectedMembers(ctx({ facts }), c.id, 1, []);
    expect(r.changedMemberIds).toEqual(expect.arrayContaining(["m1", "m2"]));
    expect(r.candidate!.changes.find((x) => x.memberId === "m1")!.reason).toContain("模拟鸡肉卷");
    expect(r.candidate!.trays.m1).not.toContain("MOCK-WRAP");
    expect(r.candidate!.hardConstraintStatus).toBe("pass");
  });

  it("保留其他成员后剩余预算不够：返回冲突，不擅自调整他人", async () => {
    const { svc } = service();
    const c = (await svc.generate(ctx({ budgetFen: 16800 }))).candidates[0]!;
    const r = await svc.replanAffectedMembers(ctx({ budgetFen: 16800, members: sixMembers({ m4: { requiredMainCount: 2 } }) }), c.id, 1, ["m4"]);
    expect(r.candidate).toBeNull();
    expect(r.conflicts[0]!.kind).toBe("total_budget");
    expect(await svc.getLatestVersion(c.id)).toBe(1);
  });
});

describe("B6 交接与实价复核", () => {
  it("CheckoutSnapshot 通过共享契约校验，不含 beCode", async () => {
    const { svc } = service();
    const c = (await svc.generate(ctx())).candidates[0]!;
    const s = await svc.getCheckoutSnapshot(c.id, 1);
    expect(CheckoutSnapshot.safeParse(s).success).toBe(true);
    expect(JSON.stringify(s)).not.toContain("beCode");
  });

  it("需求变更通知后候选 stale，快照不可再取", async () => {
    const { svc } = service();
    const c = (await svc.generate(ctx())).candidates[0]!;
    await svc.invalidate("S1", "members_changed", 2);
    expect(await svc.getCheckoutSnapshot(c.id, 1)).toBeNull();
    expect((await svc.listActive("S1")).length).toBe(0);
  });

  it("与 AI-3 CheckoutService 联调（mock）：核价、分摊守恒", async () => {
    const members = sixMembers().map((m) => ({ ...m, hardAvoid: [] }));
    const items = [STD_ITEMS[0]!, STD_ITEMS[3]!, STD_ITEMS[5]!];
    const { svc } = service();
    const c = (await svc.generate(ctx({ members, items, budgetFen: 30000 }))).candidates[0]!;
    const mock = new MockMcpTransport();
    const tools = new ToolRegistry(mock);
    await tools.init();
    const checkout = new CheckoutService({ repo: new MemoryCheckoutRepo(), tools, snapshots: svc });
    const q = await checkout.quote(c.id, c.version);
    expect(q.status).toBe("verified");
    expect(Object.values(q.memberAllocatedFen!).reduce((a, b) => a + b, 0)).toBe(q.payableFen);
    const sent = mock.calls.find((x) => x.name === "calculate-price")!.args;
    expect("beCode" in sent).toBe(false);

    // 修改后旧版本核价被拒
    await svc.applyManualEdit(ctx({ members, items, budgetFen: 30000 }), c.id, 1, { trays: { m1: ["MOCK-BURGER", "MOCK-ZERO"] } });
    await expect(checkout.quote(c.id, 1)).rejects.toMatchObject({ code: "STALE_REVISION" });
  });

  const snap = () =>
    CheckoutSnapshot.parse({
      sessionId: "S1", sessionRevision: 1, candidateId: "C1", candidateVersion: 1, mode: "mock", menuSnapshotId: "M",
      context: { beType: 1, orderType: 1, storeCode: "90000001" },
      items: [{ lineId: "L:A", productCode: "MOCK-A", quantity: 2 }, { lineId: "L:F", productCode: "MOCK-F", quantity: 1 }],
      assignments: [
        { lineId: "L:A", memberIds: ["a"], quantity: 1, shared: false },
        { lineId: "L:A", memberIds: ["b"], quantity: 1, shared: false },
        { lineId: "L:F", memberIds: ["a", "b", "c"], quantity: 1, shared: true },
      ],
      memberIds: ["a", "b", "c"], memberBudgetCapFen: { a: 3000, b: null, c: 500 }, totalBudgetFen: 6000,
      needTableware: false, hardConstraintStatus: "pass", unresolvedFactIds: [],
    });

  it("服务端行金额：订单级优惠按比例分摊，合计等于实付", () => {
    const r = validatePricedCandidate(snap(), { payableFen: 5000, lineAmountsFen: { "L:A": 4600, "L:F": 1001 } });
    expect(r.allocationSource).toBe("server_lines");
    expect(Object.values(r.memberAllocatedFen!).reduce((a, b) => a + b, 0)).toBe(5000);
    expect(r.status).toBe("pass");
  });

  it("无行金额且无分摊表：个人上限 pending，不显示通过", () => {
    const r = validatePricedCandidate(snap(), { payableFen: 5000, lineAmountsFen: null });
    expect(r.status).toBe("pending");
    expect(r.memberAllocatedFen).toBeNull();
  });

  it("组织者分摊表合计不等于实付：pending；等于实付：按表复核", () => {
    expect(validatePricedCandidate(snap(), { payableFen: 5000, lineAmountsFen: null, organizerAllocationFen: { a: 2000, b: 2000, c: 500 } }).status).toBe("pending");
    const ok = validatePricedCandidate(snap(), { payableFen: 5000, lineAmountsFen: null, organizerAllocationFen: { a: 2500, b: 2000, c: 500 } });
    expect(ok.allocationSource).toBe("organizer");
    expect(ok.status).toBe("pass");
  });

  it("个人分摊超上限或整局超预算：fail", () => {
    expect(validatePricedCandidate(snap(), { payableFen: 5000, lineAmountsFen: null, organizerAllocationFen: { a: 3500, b: 1000, c: 500 } }).status).toBe("fail");
    expect(validatePricedCandidate(snap(), { payableFen: 7000, lineAmountsFen: { "L:A": 4600, "L:F": 1100 } }).status).toBe("fail");
  });
});

describe("B5 候选解释", () => {
  it("无 LLM：确定性模板，含状态文字与图标", async () => {
    const { svc } = service();
    const c = (await svc.generate(ctx({ facts: [] }))).candidates[0]!;
    const r = await explainCandidate(c, new Map(), new Map());
    expect(r.source).toBe("template");
    expect(r.text).toContain("? 待确认");
  });

  it("LLM 声称“全部满足”但检查为 pending：拒绝并回退模板", async () => {
    const { svc } = service();
    const c = (await svc.generate(ctx({ facts: [] }))).candidates[0]!;
    const llm = { complete: async () => JSON.stringify({ summary: "这套方案全部满足大家的要求" }) };
    expect((await explainCandidate(c, new Map(), new Map(), llm)).source).toBe("template");
  });

  it("LLM 输出虚构价格或编码：拒绝；LLM 异常：回退", async () => {
    const { svc } = service();
    const c = (await svc.generate(ctx())).candidates[0]!;
    expect(validateExplanation("只要 88.88 元", c, new Map())).toBe(false);
    expect(validateExplanation("包含 MOCK-WRAP", c, new Map())).toBe(false);
    const bad = { complete: async () => "not json" };
    expect((await explainCandidate(c, new Map(), new Map(), bad)).source).toBe("template");
    const good = { complete: async () => JSON.stringify({ summary: "整体最省钱，每人一份鸡肉卷" }) };
    expect((await explainCandidate(c, new Map(), new Map(), good)).source).toBe("llm");
  });
});
