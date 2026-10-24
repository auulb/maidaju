import type { AppMode } from "@/contracts";

export type ToolResult = { ok: true; data: unknown; raw: unknown } | { ok: false; message: string; raw: unknown };

export interface McpTransport {
  readonly mode: AppMode;
  listTools(): Promise<string[]>;
  callTool(name: string, args: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<ToolResult>;
}

/** 请求已发出但结果未知（超时/断连）。调用方必须区分它与明确失败。 */
export class McpOutcomeUnknownError extends Error {}
/** 请求未能发出（连接被拒等），可以确定远端未执行 */
export class McpNotSentError extends Error {}

/** 业务逻辑名 -> 允许的实际工具名（以 tools/list 为准） */
export const TOOL_ALIASES = {
  queryNearbyStores: ["query-nearby-stores", "query_nearby_stores"],
  queryMeals: ["query-meals", "query_meals"],
  queryMealDetail: ["query-meal-detail", "query_meal_detail"],
  queryStoreCoupons: ["query-store-coupons", "query_store_coupons"],
  calculatePrice: ["calculate-price", "calculate_price"],
  createOrder: ["create-order", "create_order"],
  queryOrder: ["query-order", "query_order"],
  nowTime: ["now-time-info", "now_time_info"],
} as const;
export type LogicalTool = keyof typeof TOOL_ALIASES;

/** 首版白名单：不包含取消订单、抽奖、积分兑换等副作用工具 */
export class ToolRegistry {
  private resolved = new Map<LogicalTool, string>();
  constructor(private transport: McpTransport) {}

  async init(): Promise<{ missing: LogicalTool[] }> {
    const names = new Set(await this.transport.listTools());
    const missing: LogicalTool[] = [];
    for (const [logical, aliases] of Object.entries(TOOL_ALIASES) as [LogicalTool, readonly string[]][]) {
      const hit = aliases.find((a) => names.has(a));
      if (hit) this.resolved.set(logical, hit);
      else missing.push(logical);
    }
    return { missing };
  }

  call(tool: LogicalTool, args: Record<string, unknown>, opts?: { timeoutMs?: number }) {
    const name = this.resolved.get(tool);
    if (!name) throw new Error(`工具 ${tool} 未在 tools/list 中找到，真实链路阻塞`);
    return this.transport.callTool(name, args, opts);
  }

  get mode() {
    return this.transport.mode;
  }
}
