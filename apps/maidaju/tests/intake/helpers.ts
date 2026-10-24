import type { ToolResult } from "@/server/mcp/transport";
import type { IntakeDeps, InvalidationReason, ReadOnlyTool, ToolCaller } from "@/modules/ports";
import { MemoryIntakeRepository } from "@/modules/intake/memory-repo";
import { MOCK_COUPONS, MOCK_DETAIL, MOCK_MEALS, MOCK_STORES } from "../fixtures/intake/mcp-responses";

export class FakeTools implements ToolCaller {
  readonly mode = "mock" as const;
  calls: { tool: ReadOnlyTool; args: Record<string, unknown> }[] = [];
  fail = new Set<ReadOnlyTool>();
  responses: Partial<Record<ReadOnlyTool, unknown>> = {
    queryNearbyStores: MOCK_STORES,
    queryMeals: MOCK_MEALS,
    queryStoreCoupons: MOCK_COUPONS,
    queryMealDetail: MOCK_DETAIL,
  };
  async call(tool: ReadOnlyTool, args: Record<string, unknown>): Promise<ToolResult> {
    this.calls.push({ tool, args: structuredClone(args) });
    if (this.fail.has(tool)) return { ok: false, message: "模拟失败", raw: null };
    const data = this.responses[tool];
    return { ok: true, data, raw: data };
  }
}

export function makeDeps() {
  let seq = 0;
  const invalidations: { sessionId: string; reason: InvalidationReason; rev: number }[] = [];
  const repo = new MemoryIntakeRepository();
  const tools = new FakeTools();
  const deps: IntakeDeps = {
    repo,
    tools,
    invalidation: { invalidate: async (sessionId, reason, rev) => void invalidations.push({ sessionId, reason, rev }) },
    now: () => "2026-10-24T08:00:00.000Z",
    newId: () => `id-${++seq}`,
  };
  return { deps, repo, tools, invalidations };
}

export const sixMembers = () =>
  Array.from({ length: 6 }, (_, i) => ({
    memberId: `m${i + 1}`,
    alias: `成员${i + 1}`,
    requiredMainCount: 1,
    hardAvoid: i < 2 ? (["spicy"] as const).slice() : i === 2 ? (["sugary_drink"] as const).slice() : [],
    softPrefer: [],
    budgetCapFen: null,
  }));
