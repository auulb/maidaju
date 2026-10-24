// 金额全部为整数分；活动按订单满足门槛后计算，排除商品不打折；不叠加多个档位。
import { z } from "zod";

export const PriceRule = z.object({
  id: z.string(), label: z.string(), thresholdFen: z.number().int().nonnegative(),
  discountPercent: z.number().int().min(0).max(100).optional(),
  reduceFen: z.number().int().nonnegative().optional(), excludedCodes: z.array(z.string()).default([]),
});
export const PricingModel = z.object({
  deliveryFen: z.number().int().nonnegative(), packingFen: z.number().int().nonnegative(),
  serviceCode: z.string().optional(), serviceLabel: z.string().optional(), rules: z.array(PriceRule),
});
export type PricingModel = z.infer<typeof PricingModel>;
export type PriceBreakdown = {
  originalFen: number; discountFen: number; deliveryFen: number; packingFen: number; payableFen: number;
  promotionLabel: string | null; serviceLabel: string | null; nextThresholdFen: number | null;
};
export const DEMO_CATERING_RULES: PricingModel["rules"] = [
  { id: "tier300", label: "满 ¥300 打 7.8 折", thresholdFen: 30000, discountPercent: 22, excludedCodes: ["MOCK-FIT-COMBO"] },
  { id: "tier500", label: "满 ¥500 打 7.4 折", thresholdFen: 50000, discountPercent: 26, excludedCodes: ["MOCK-FIT-COMBO"] },
  { id: "tier1000", label: "满 ¥1000 打 7 折", thresholdFen: 100000, discountPercent: 30, excludedCodes: ["MOCK-FIT-COMBO"] },
];
export function demoPricing(beType: number): PricingModel {
  return { deliveryFen: beType === 2 || beType === 6 ? 600 : 0, packingFen: beType === 2 || beType === 6 ? 300 : 0,
    ...(beType === 6 ? { serviceCode: "MOCK-GMS001", serviceLabel: "保鲜速达（演示）" } : {}),
    rules: beType === 6 ? DEMO_CATERING_RULES : [] };
}
export function priceCart(lines: { code: string; unitFen: number; quantity: number }[], model: PricingModel = demoPricing(1)): PriceBreakdown {
  const originalFen = lines.reduce((s, l) => s + l.unitFen * l.quantity, 0);
  let discountFen = 0, promotionLabel: string | null = null;
  for (const rule of model.rules) {
    if (originalFen < rule.thresholdFen) continue;
    const eligible = lines.filter((l) => !rule.excludedCodes.includes(l.code)).reduce((s, l) => s + l.unitFen * l.quantity, 0);
    const discount = Math.min(eligible, rule.discountPercent != null ? Math.round(eligible * rule.discountPercent / 100) : rule.reduceFen ?? 0);
    if (discount > discountFen) { discountFen = discount; promotionLabel = rule.label; }
  }
  const next = model.rules.filter((r) => r.thresholdFen > originalFen).sort((a, b) => a.thresholdFen - b.thresholdFen)[0];
  return { originalFen, discountFen, deliveryFen: model.deliveryFen, packingFen: model.packingFen,
    payableFen: originalFen - discountFen + model.deliveryFen + model.packingFen, promotionLabel,
    serviceLabel: model.serviceLabel ?? null, nextThresholdFen: next ? next.thresholdFen - originalFen : null };
}
