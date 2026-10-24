import { describe, expect, it } from "vitest";
import { demoPricing, priceCart } from "@/modules/planning/pricing";
import { feastContext } from "./feast-fixture";
import { service } from "./fixtures";
import { MockMcpTransport } from "@/server/mcp/mock";
import { ToolRegistry } from "@/server/mcp/transport";
import { CheckoutService } from "@/modules/checkout/service";
import { MemoryCheckoutRepo } from "@/modules/checkout/repo";
import { buildCreateOrderArgs, buildPriceArgs } from "@/modules/checkout/params";

describe("Skill 整单计价", () => {
  it("满折门槛有跳变，预算按实付；排除商品不打折", () => {
    const model = demoPricing(6);
    expect(priceCart([{ code: "A", unitFen: 29900, quantity: 1 }], model).payableFen).toBe(30800);
    expect(priceCart([{ code: "A", unitFen: 30000, quantity: 1 }], model).payableFen).toBe(24300);
    const p = priceCart([{ code: "A", unitFen: 28000, quantity: 1 }, { code: "MOCK-FIT-COMBO", unitFen: 2800, quantity: 1 }], model);
    expect(p.discountFen).toBe(6160);
    expect(p.nextThresholdFen).toBe(19200);
  });
  it("满减只取最优一档，不叠加；优惠不能大于参与金额", () => {
    const p = priceCart([{ code: "A", unitFen: 5000, quantity: 1 }], {
      deliveryFen: 0, packingFen: 0, rules: [
        { id: "a", label: "满30减5", thresholdFen: 3000, reduceFen: 500, excludedCodes: [] },
        { id: "b", label: "满50减10", thresholdFen: 5000, reduceFen: 1000, excludedCodes: [] },
      ],
    });
    expect(p.payableFen).toBe(4000); expect(p.promotionLabel).toBe("满50减10");
  });
  it.each([1, 5, 2, 6] as const)("模式 %i：三套均在实付预算内，核价和分摊与规划完全一致", async (beType) => {
    const context = feastContext();
    context.pricing = demoPricing(beType);
    context.menu.context = beType === 1 ? { beType, orderType: 1, storeCode: "90000001" }
      : beType === 5 ? { beType, orderType: 1, storeCode: "90000001", beCode: "MOCK-BE" }
      : beType === 2 ? { beType, orderType: 2, storeCode: "90000001", beCode: "MOCK-BE", addressId: "MOCK-ADDRESS" }
      : { beType, orderType: 2, storeCode: "90000001", beCode: "MOCK-BE", addressId: "MOCK-ADDRESS", gmServiceCode: "MOCK-GMS001" };
    const { svc } = service();
    const r = await svc.generate(context);
    expect(r.candidates).toHaveLength(3);
    const tools = new ToolRegistry(new MockMcpTransport()); await tools.init();
    const checkout = new CheckoutService({ repo: new MemoryCheckoutRepo(), tools, snapshots: svc });
    for (const c of r.candidates) {
      expect(c.estimatedTotalFen).toBeLessThanOrEqual(30000);
      const q = await checkout.quote(c.id, 1);
      expect(q.payableFen).toBe(c.estimatedTotalFen);
      expect(q.memberAllocatedFen).toEqual(c.estimatedMemberFen);
      expect(q.budgetOk).toBe("pass");
      const snapshot = (await svc.getCheckoutSnapshot(c.id, 1))!;
      const price = buildPriceArgs(snapshot), create = buildCreateOrderArgs(snapshot, "TW");
      if (beType === 1) expect(price).not.toHaveProperty("beCode");
      else expect(price).toHaveProperty("beCode", "MOCK-BE");
      if (beType === 2 || beType === 6) {
        expect(create).toHaveProperty("addressId", "MOCK-ADDRESS"); expect(create).not.toHaveProperty("takeWayCode");
      }
      if (beType === 6) {
        expect(c.pricing!.discountFen).toBeGreaterThan(0);
        expect(c.pricing!.originalFen).toBeGreaterThan(30000);
        expect(price).toHaveProperty("gmServiceCode");
      }
    }
  });
});
