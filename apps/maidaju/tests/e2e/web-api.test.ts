import { describe, expect, it } from "vitest";
import { callLocalApi } from "@/web/local-backend";
import type { Candidate } from "@/modules/planning/types";

async function api(method: string, path: string, body: unknown = {}) {
  const r = await callLocalApi(method, path, JSON.stringify(body));
  const parsed = JSON.parse(r.body);
  if (!parsed.ok) throw new Error(`${r.status}: ${parsed.error.message}`);
  return parsed.data;
}

describe("浏览器静态后端与页面 API 真正接线", () => {
  it("表单保存 → 团餐选店 → 三方案 → 核价；修改模式后不能使用旧菜单", async () => {
    let data = await api("POST", "/api/session", { name: "点击点餐", memberCount: 8, budgetYuan: "300", city: "上海市", keyword: "人民广场", beType: 6, deliveryAddress: "体验大厦 8 楼" });
    const root = `/api/sessions/${data.session.id}`;
    data = await api("GET", `${root}/stores`);
    data = await api("POST", `${root}/store`, { storeCode: data.stores[0].storeCode, revision: data.session.revision });
    data = await api("POST", `${root}/catalog`, { revision: data.session.revision });
    data = await api("POST", `${root}/candidates`);
    expect(data.candidates.map((c: Candidate) => c.label)).toEqual(["多元体验", "健身活力", "能量满格"]);
    const candidate: Candidate = data.candidates[0];
    expect(candidate.hardConstraintStatus).toBe("pass");
    expect(candidate.pricing!.discountFen).toBeGreaterThan(0);
    const q = await api("POST", `${root}/quote`, { candidateId: candidate.id, version: candidate.version });
    expect(q.payableFen).toBe(candidate.estimatedTotalFen);
    expect(q.memberAllocatedFen).toEqual(candidate.estimatedMemberFen);
    // 生成与核价没有创建订单，只有明确授权接口才允许继续。
    const invalid = await callLocalApi("POST", `${root}/authorize`, JSON.stringify({ quoteId: q.id, takeWayCode: q.takeWayOptions[0].code, userConfirmed: false }));
    expect(JSON.parse(invalid.body).error.code).toBe("NEEDS_USER_INPUT");
    data = await api("POST", `${root}/setup`, { revision: data.session.revision, beType: 1 });
    expect(data.menu).toBeNull(); expect(data.candidates).toEqual([]);
    const stale = await callLocalApi("POST", `${root}/quote`, JSON.stringify({ candidateId: candidate.id, version: candidate.version }));
    expect(JSON.parse(stale.body).ok).toBe(false);
  });

  it("随单购卡价不当作普通菜单价；未提供原价时保持待核价", async () => {
    const { normalizeMeals } = await import("@/modules/catalog/normalize");
    const out = normalizeMeals({ meals: [
      { code: "A", name: "随单购套餐", currentPrice: 1500, originalPrice: 3000, discountType: "随单购麦金卡" },
      { code: "B", name: "未提供原价", currentPrice: 1500, card_required: true },
    ] }, "test", "fen");
    expect(out.items.map((p) => p.priceFen)).toEqual([3000, null]);
  });
});
