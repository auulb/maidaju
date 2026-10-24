// 端到端（MOCK）：AI-1 需求/菜单 → AI-2 候选 → AI-3 核价/授权/下单/查单，验证三个模块真实接线。
import { describe, expect, it } from "vitest";
import type { InvalidationReason, InvalidationSink, IntakeDeps } from "@/modules/ports";
import { MemoryIntakeRepository } from "@/modules/intake/memory-repo";
import { createSession, saveMembers, updateSession } from "@/modules/intake/session";
import { getPlanningContext, refreshCatalog, searchStores, selectStore } from "@/modules/catalog/store";
import { confirmFact } from "@/modules/catalog/facts";
import type { FactAttribute } from "@/modules/catalog/types";
import { MemoryCandidateRepository } from "@/modules/planning/repo";
import { PlanningService } from "@/modules/planning/service";
import { MemoryCheckoutRepo } from "@/modules/checkout/repo";
import { CheckoutService } from "@/modules/checkout/service";
import { MockMcpTransport } from "@/server/mcp/mock";
import { ToolRegistry } from "@/server/mcp/transport";
import { FakeTools, sixMembers } from "../intake/helpers";

async function setup() {
  let seq = 0;
  const transport = new MockMcpTransport();
  const registry = new ToolRegistry(transport);
  await registry.init();
  const planning = new PlanningService({
    repo: new MemoryCandidateRepository(),
    now: () => "2026-10-24T08:00:00.000Z",
    newId: () => `cand-${++seq}`,
    clockMs: () => 0,
  });
  const checkout = new CheckoutService({ repo: new MemoryCheckoutRepo(), tools: registry, snapshots: planning });
  const reasons: InvalidationReason[] = [];
  // 生产中的组合失效：AI-1 变更同时通知 AI-2（候选）与 AI-3（报价/授权）
  const sink: InvalidationSink = {
    async invalidate(sessionId, reason, rev) {
      reasons.push(reason);
      await planning.invalidate(sessionId, reason, rev);
      await checkout.invalidate(sessionId);
    },
  };
  const tools = new FakeTools(); // AI-1 只读工具；返回与 MockMcpTransport 同一套 MOCK 商品
  const deps: IntakeDeps = { repo: new MemoryIntakeRepository(), tools, invalidation: sink, now: () => "2026-10-24T08:00:00.000Z", newId: () => `id-${++seq}` };
  return { deps, planning, checkout, transport, reasons };
}

const FACTS: Record<string, Partial<Record<FactAttribute, boolean>>> = {
  "MOCK-BURGER": { is_main: true, contains_spicy: true, is_sugary_drink: false },
  "MOCK-BURGER-MILD": { is_main: true, contains_spicy: false, is_sugary_drink: false },
  "MOCK-COLA": { is_main: false, contains_spicy: false, is_sugary_drink: true },
  "MOCK-ZERO": { is_main: false, contains_spicy: false, is_sugary_drink: false },
  "MOCK-COMBO": { is_main: false, contains_spicy: true, is_sugary_drink: true },
};

async function readySession(env: Awaited<ReturnType<typeof setup>>, budgetYuan = "240") {
  const { deps } = env;
  let s = await createSession(deps, { mode: "mock", name: "周五团建", memberCount: 6, budget: { kind: "total", yuan: budgetYuan }, city: "上海市", keyword: "人民广场" });
  s = (await saveMembers(deps, s.id, sixMembers(), s.revision)).session;
  await searchStores(deps, s.id);
  s = await selectStore(deps, s.id, "90000001", s.revision);
  s = (await refreshCatalog(deps, s.id, s.revision, { priceUnit: "fen" })).session;
  for (const [code, attrs] of Object.entries(FACTS)) {
    for (const [attr, value] of Object.entries(attrs)) {
      await confirmFact(deps, s.id, { subjectId: code, attribute: attr as FactAttribute, value: value!, basis: "组织者核对门店菜单", confirmedBy: "organizer" }, s.revision);
      s = (await deps.repo.getSession(s.id))!;
    }
  }
  return s;
}

describe("E2E 首个验收场景（MOCK）：6 人 / 240 元 / 2 人不吃辣 / 1 人不喝含糖饮料", () => {
  it("需求 → 候选 → 核价 → 授权 → 下单 → 查单", async () => {
    const env = await setup();
    const { deps, planning, checkout, transport } = env;
    const s = await readySession(env);

    const ctx = await getPlanningContext(deps, s.id);
    const gen = await planning.generate(ctx);
    expect(gen.candidates.length).toBeGreaterThanOrEqual(1);
    const c = gen.candidates.find((x) => x.hardConstraintStatus === "pass")!;
    expect(c).toBeDefined();
    expect(c.unresolvedFactIds).toEqual([]);
    for (const m of ["m1", "m2"]) expect(c.trays[m]).not.toContain("MOCK-BURGER");
    expect(c.trays.m3).not.toContain("MOCK-COLA");

    const q = await checkout.quote(c.id, c.version);
    expect(q.status).toBe("verified");
    expect(q.payableFen).toBeLessThanOrEqual(24000);
    expect(q.budgetOk).toBe("pass");

    const auth = await checkout.authorize({ quoteId: q.id, takeWayCode: q.takeWayOptions[0]!.code, acknowledgedFactIds: [], organizerId: "organizer", userConfirmed: true });
    const { attempt, order } = await checkout.createOrder(auth.id, "idem-1");
    expect(attempt.status).toBe("succeeded");
    expect(order!.orderId).toMatch(/^MOCK-ORDER-/);
    // 双击：不再发远程请求
    await checkout.createOrder(auth.id, "idem-1");
    expect(transport.calls.filter((x) => x.name === "create-order")).toHaveLength(1);

    const sent = transport.calls.find((x) => x.name === "create-order")!.args;
    expect(sent).toMatchObject({ beType: 1, orderType: 1, storeCode: "90000001" });
    expect(JSON.stringify(sent)).not.toMatch(/beCode|lineId/);

    const o = await checkout.refreshOrder(order!.orderId);
    expect(o.serverStatus).not.toBeNull();
  });

  it("核价后修改需求：候选与报价全部失效，授权被拒", async () => {
    const env = await setup();
    const { deps, planning, checkout } = env;
    const s = await readySession(env);
    const c = (await planning.generate(await getPlanningContext(deps, s.id))).candidates[0]!;
    const q = await checkout.quote(c.id, c.version);

    await updateSession(deps, s.id, { budget: { kind: "total", yuan: "260" } }, s.revision);
    expect(env.reasons).toContain("session_changed");
    expect(await planning.getCheckoutSnapshot(c.id, c.version)).toBeNull();
    await expect(
      checkout.authorize({ quoteId: q.id, takeWayCode: q.takeWayOptions[0]!.code, acknowledgedFactIds: [], organizerId: "organizer", userConfirmed: true }),
    ).rejects.toMatchObject({ code: "QUOTE_STALE" });
  });

  it("未确认事实：真实链路产出 pending 候选，授权前须逐项接受", async () => {
    const env = await setup();
    const { deps, planning, checkout } = env;
    let s = await createSession(deps, { mode: "mock", name: "未确认", memberCount: 6, budget: { kind: "total", yuan: "300" }, city: "上海市", keyword: "人民广场" });
    s = (await saveMembers(deps, s.id, sixMembers().map((m) => ({ ...m, hardAvoid: [] })), s.revision)).session;
    await searchStores(deps, s.id);
    s = await selectStore(deps, s.id, "90000001", s.revision);
    s = (await refreshCatalog(deps, s.id, s.revision, { priceUnit: "fen" })).session;

    const gen = await planning.generate(await getPlanningContext(deps, s.id));
    const c = gen.candidates[0]!;
    expect(c.hardConstraintStatus).toBe("pending");
    const q = await checkout.quote(c.id, c.version);
    const base = { quoteId: q.id, takeWayCode: q.takeWayOptions[0]!.code, organizerId: "organizer", userConfirmed: true };
    await expect(checkout.authorize({ ...base, acknowledgedFactIds: [] })).rejects.toMatchObject({ code: "FACT_PENDING" });
    const a = await checkout.authorize({ ...base, acknowledgedFactIds: c.unresolvedFactIds });
    expect(a.acknowledgedFactIds).toEqual(c.unresolvedFactIds);
  });
});
