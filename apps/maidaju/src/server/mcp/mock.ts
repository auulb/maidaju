// 模拟 transport：所有 code 带 MOCK- 前缀，真实链路会拒绝。
import { McpOutcomeUnknownError, type McpTransport, type ToolResult } from "./transport";
import { DEMO_PRODUCTS } from "./demo-data";
import { demoPricing, priceCart } from "@/modules/planning/pricing";

export type MockCall = { name: string; args: Record<string, unknown> };

export class MockMcpTransport implements McpTransport {
  readonly mode = "mock" as const;
  readonly calls: MockCall[] = [];
  /** 测试钩子：下一次 create-order 超时 */
  failNextCreateWith: "timeout" | "reject" | null = null;
  priceDeltaFen = 0;
  takeWays = [{ code: "MOCK-TW-1", label: "堂食（模拟）" }, { code: "MOCK-TW-2", label: "外带（模拟）" }];
  private seq = 0;
  // 与 tests/fixtures/intake/mcp-responses.ts、tests/planning/fixtures.ts 的模拟菜单保持一致
  private prices: Record<string, number> = Object.fromEntries(DEMO_PRODUCTS.map((p) => [p.code, p.price]));

  async listTools() {
    return ["query-nearby-stores", "query-meals", "query-meal-detail", "query-store-coupons", "calculate-price", "create-order", "query-order", "now-time-info"];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    this.calls.push({ name, args: structuredClone(args) });
    switch (name) {
      case "calculate-price": {
        const items = (args.items as { productCode: string; quantity: number }[]) ?? [];
        const unknown = items.find((i) => !(i.productCode in this.prices));
        if (unknown) return { ok: false, message: `商品 ${unknown.productCode} 不可售`, raw: null };
        const original = items.reduce((s, i) => s + this.prices[i.productCode]! * i.quantity, 0);
        const priced = priceCart(items.map((i) => ({ code: i.productCode, unitFen: this.prices[i.productCode]!, quantity: i.quantity })), demoPricing(Number(args.beType ?? 1)));
        const data = {
          data: {
            originalPrice: original,
            realTotalAmount: priced.payableFen + this.priceDeltaFen,
            productList: items.map((i) => ({ productCode: i.productCode, quantity: i.quantity, realSubtotal: this.prices[i.productCode]! * i.quantity })),
            takeWayList: args.orderType === 2 ? [{ code: "MOCK-DELIVERY", label: "配送到填写的地址（模拟）" }] : args.beType === 5 ? [{ code: "MOCK-DT", label: "得来速车道取餐（模拟）" }] : this.takeWays,
          },
        };
        return { ok: true, data, raw: data };
      }
      case "create-order": {
        const mode = this.failNextCreateWith;
        this.failNextCreateWith = null;
        if (mode === "timeout") throw new McpOutcomeUnknownError("请求超时");
        if (mode === "reject") return { ok: false, message: "门店暂停营业（模拟）", raw: null };
        const data = { data: { orderId: `MOCK-ORDER-${++this.seq}`, payUrl: null } };
        return { ok: true, data, raw: data };
      }
      case "query-order": {
        const data = { data: { orderId: args.orderId, orderStatusText: "待支付（模拟）" } };
        return { ok: true, data, raw: data };
      }
      default:
        return { ok: true, data: { data: [] }, raw: null };
    }
  }
}
