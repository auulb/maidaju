// 模拟数据：所有 code 带 MOCK- 前缀，仅用于测试。
import type { CheckoutSnapshot } from "@/contracts";
import { MockMcpTransport } from "@/server/mcp/mock";
import { ToolRegistry } from "@/server/mcp/transport";
import { MemoryCheckoutRepo } from "@/modules/checkout/repo";
import { CheckoutService, type SnapshotSource } from "@/modules/checkout/service";

export function makeSnapshot(over: Partial<CheckoutSnapshot> = {}): CheckoutSnapshot {
  return {
    sessionId: "S1",
    sessionRevision: 3,
    candidateId: "C1",
    candidateVersion: 1,
    mode: "mock",
    menuSnapshotId: "M1",
    context: { beType: 1, orderType: 1, storeCode: "1450001" },
    items: [
      { lineId: "L1", productCode: "MOCK-BURGER", quantity: 2 },
      { lineId: "L2", productCode: "MOCK-FRIES", quantity: 1 },
    ],
    assignments: [
      { lineId: "L1", memberIds: ["a"], quantity: 1, shared: false },
      { lineId: "L1", memberIds: ["b"], quantity: 1, shared: false },
      { lineId: "L2", memberIds: ["a", "b", "c"], quantity: 1, shared: true },
    ],
    memberIds: ["a", "b", "c"],
    memberBudgetCapFen: { a: null, b: null, c: null },
    totalBudgetFen: 15000,
    needTableware: false,
    hardConstraintStatus: "pass",
    unresolvedFactIds: [],
    ...over,
  };
}

export class SnapStore implements SnapshotSource {
  snaps = new Map<string, CheckoutSnapshot>();
  put(s: CheckoutSnapshot) { this.snaps.set(`${s.candidateId}@${s.candidateVersion}`, structuredClone(s)); }
  async getCheckoutSnapshot(id: string, v: number) { return structuredClone(this.snaps.get(`${id}@${v}`) ?? null); }
  async getLatestVersion(id: string) {
    const vs = [...this.snaps.values()].filter((s) => s.candidateId === id).map((s) => s.candidateVersion);
    return vs.length ? Math.max(...vs) : null;
  }
}

export async function setup(snap = makeSnapshot()) {
  const mock = new MockMcpTransport();
  const tools = new ToolRegistry(mock);
  await tools.init();
  const repo = new MemoryCheckoutRepo();
  const snapshots = new SnapStore();
  snapshots.put(snap);
  let t = Date.parse("2026-10-24T12:00:00Z");
  const clock = { advance: (ms: number) => (t += ms) };
  const svc = new CheckoutService({ repo, tools, snapshots, now: () => new Date(t) });
  const creates = () => mock.calls.filter((c) => c.name === "create-order").length;
  return { mock, tools, repo, snapshots, svc, clock, creates, snap };
}

export const confirm = { takeWayCode: "MOCK-TW-1", acknowledgedFactIds: [], organizerId: "org", userConfirmed: true };
