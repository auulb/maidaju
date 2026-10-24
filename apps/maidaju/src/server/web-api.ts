// 本地演示 API：组合 AI-1 / AI-2 / AI-3，仅使用模拟数据，不连接真实 MCP。
import { randomUUID } from "@/lib/ids";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { IntakeDeps, ReadOnlyTool, ToolCaller } from "@/modules/ports";
import { MemoryIntakeRepository } from "@/modules/intake/memory-repo";
import { createSession, loadSession, saveMembers, updateSession, type MemberInput } from "@/modules/intake/session";
import { getPlanningContext, refreshCatalog, searchStores, selectStore } from "@/modules/catalog/store";
import { AVOID_TO_ATTRIBUTE, confirmFact } from "@/modules/catalog/facts";
import type { FactAttribute } from "@/modules/catalog/types";
import { MemoryCandidateRepository } from "@/modules/planning/repo";
import { PlanningService } from "@/modules/planning/service";
import { MemoryCheckoutRepo } from "@/modules/checkout/repo";
import { CheckoutService } from "@/modules/checkout/service";
import { MockMcpTransport } from "@/server/mcp/mock";
import { ToolRegistry, type ToolResult } from "@/server/mcp/transport";
import { AppError } from "@/server/errors";
import { DEMO_FACTS, DEMO_MEALS, DEMO_STORES, DEMO_PRODUCTS, demoDetail } from "./mcp/demo-data";

class DemoTools implements ToolCaller {
  readonly mode = "mock" as const;
  async call(tool: ReadOnlyTool, args: Record<string, unknown>): Promise<ToolResult> {
    let data: unknown;
    switch (tool) {
      case "queryNearbyStores": data = DEMO_STORES; break;
      case "queryMeals": data = DEMO_MEALS; break;
      case "queryMealDetail": data = demoDetail(String(args.code ?? "")); break;
      case "queryStoreCoupons": data = { data: { coupons: [] } }; break;
    }
    return { ok: true, data, raw: data };
  }
}

function createState() {
  const intake = new MemoryIntakeRepository();
  const checkoutRepo = new MemoryCheckoutRepo();
  const tools = new ToolRegistry(new MockMcpTransport());
  const ready = tools.init().then(({ missing }) => {
    if (missing.length) throw new Error(`模拟工具初始化失败：${missing.join(", ")}`);
  });
  const planning = new PlanningService({
    repo: new MemoryCandidateRepository(),
    now: () => new Date().toISOString(),
    newId: () => `candidate-${randomUUID()}`,
    clockMs: () => Date.now(),
  });
  const checkout = new CheckoutService({ repo: checkoutRepo, tools, snapshots: planning });
  const deps: IntakeDeps = {
    repo: intake,
    tools: new DemoTools(),
    invalidation: {
      async invalidate(sessionId, reason, revision) {
        await planning.invalidate(sessionId, reason, revision);
        await checkout.invalidate(sessionId);
      },
    },
    now: () => new Date().toISOString(),
    newId: () => `demo-${randomUUID()}`,
  };
  return { deps, planning, checkout, checkoutRepo, ready };
}
type WebState = ReturnType<typeof createState>;
let state: WebState | null = null;
const env = () => state ??= createState();

function send(res: ServerResponse, status: number, data: unknown) {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(data));
}
const ok = (res: ServerResponse, data: unknown) => send(res, 200, { ok: true, data });
const missing = (message: string) => new AppError("VALIDATION", message, false, { notFound: true });

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
    size += buffer.byteLength;
    if (size > 1_000_000) throw new AppError("VALIDATION", "请求内容过大");
    chunks.push(buffer);
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const raw = new TextDecoder().decode(merged);
  if (!raw.trim()) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new AppError("VALIDATION", "请求体不是有效的 JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new AppError("VALIDATION", "请求体必须是 JSON 对象");
  return parsed as Record<string, unknown>;
}
function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new AppError("VALIDATION", `缺少${name}`);
  return value;
}
function integer(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new AppError("VALIDATION", `${name}必须是整数`);
  return value;
}
function defaultMembers(count: number): MemberInput[] {
  return Array.from({ length: count }, (_, i) => ({
    memberId: `m${i + 1}`, alias: `成员${i + 1}`, requiredMainCount: 1,
    hardAvoid: [],
    softPrefer: [], budgetCapFen: null,
  }));
}
async function payload(e: WebState, sessionId: string) {
  const session = await loadSession(e.deps, sessionId);
  const [members, stores, menu, candidates] = await Promise.all([
    e.deps.repo.getMembers(sessionId), e.deps.repo.getStoreSearch(sessionId),
    e.deps.repo.getMenuSnapshot(sessionId), e.planning.listActive(sessionId),
  ]);
  return { session, members, stores, menu, candidates, demoFacts: menu ? DEMO_FACTS : {} };
}
async function confirmDemoFacts(e: WebState, sessionId: string) {
  const d = e.deps;
  let session = await loadSession(d, sessionId);
  const menu = await d.repo.getMenuSnapshot(sessionId);
  if (!menu) throw new AppError("NEEDS_USER_INPUT", "请先加载菜单");
  const members = await d.repo.getMembers(sessionId);
  const attrs = new Set<FactAttribute>(["is_main"]);
  for (const member of members) for (const avoid of member.hardAvoid) attrs.add(AVOID_TO_ATTRIBUTE[avoid]);
  let count = 0;
  for (const item of menu.items) for (const attribute of attrs) {
    const value = DEMO_FACTS[item.code]?.[attribute];
    if (value === undefined) continue;
    await confirmFact(d, sessionId, {
      subjectId: item.code, attribute, value,
      basis: "演示菜单提供的模拟事实，仅用于体验流程", confirmedBy: "演示组织者",
    }, session.revision);
    session = await loadSession(d, sessionId);
    count++;
  }
  return count;
}

export async function handleApi(req: IncomingMessage, res: ServerResponse) {
  try {
    const url = new URL(req.url ?? "/", "http://maidaju.local");
    const path = url.pathname;
    if (req.method === "GET" && path === "/api/health") return ok(res, { mode: "mock", message: "麦搭局演示服务运行中" });
    const e = env();
    await e.ready;
    if (req.method === "POST" && path === "/api/reset") {
      state = null;
      return ok(res, { reset: true });
    }
    if (req.method === "GET" && path === "/api/state") {
      const id = url.searchParams.get("sessionId");
      return ok(res, id ? await payload(e, id) : { session: null });
    }
    if (req.method === "POST" && path === "/api/session") {
      const p = await body(req);
      const count = integer(p.memberCount ?? 6, "人数");
      const session = await createSession(e.deps, {
        mode: "mock", name: String(p.name ?? "我的麦搭局"), memberCount: count,
        budget: { kind: "total", yuan: String(p.budgetYuan ?? "150") },
        city: String(p.city ?? "上海市"), keyword: String(p.keyword ?? "人民广场"),
        needTableware: p.needTableware === true,
        beType: (p.beType ?? 1) as 1 | 2 | 5 | 6, deliveryAddress: String(p.deliveryAddress ?? ""),
      });
      await saveMembers(e.deps, session.id, (p.members ?? defaultMembers(count)) as MemberInput[], session.revision);
      return ok(res, await payload(e, session.id));
    }
    const match = /^\/api\/sessions\/([^/]+)(?:\/(.*))?$/.exec(path);
    if (!match) throw missing("接口不存在");
    const sessionId = decodeURIComponent(match[1]!);
    const action = match[2] ?? "";
    const session = await loadSession(e.deps, sessionId);
    const p = req.method === "POST" ? await body(req) : {};
    const d = e.deps;

    if (req.method === "POST" && action === "setup") {
      const nextCount = integer(p.memberCount ?? session.memberCount, "人数");
      const updated = await updateSession(d, sessionId, {
        name: String(p.name ?? session.name), memberCount: nextCount,
        budget: { kind: "total", yuan: String(p.budgetYuan ?? session.budgetFen / 100) },
        city: String(p.city ?? session.city ?? ""), keyword: String(p.keyword ?? session.keyword ?? ""),
        needTableware: p.needTableware === undefined ? session.needTableware : p.needTableware === true,
        beType: (p.beType ?? session.beType ?? 1) as 1 | 2 | 5 | 6,
        deliveryAddress: String(p.deliveryAddress ?? session.deliveryAddress ?? ""),
      }, integer(p.revision, "版本号"));
      if (nextCount !== session.memberCount) {
        const previous = await d.repo.getMembers(sessionId);
        const members = defaultMembers(nextCount).map((member, i) => {
          const existing = previous[i];
          if (!existing) return member;
          const { revision: _revision, ...input } = existing;
          return input;
        });
        await saveMembers(d, sessionId, members, updated.revision);
      }
      if (updated.city !== session.city || updated.keyword !== session.keyword || updated.beType !== session.beType || updated.deliveryAddress !== session.deliveryAddress) {
        await d.repo.saveStoreSearch(sessionId, []);
        await d.repo.saveMenuSnapshot(sessionId, null);
        await d.repo.replaceFactConfirmations(sessionId, []);
      }
      return ok(res, await payload(e, sessionId));
    }
    if (req.method === "POST" && action === "members") {
      await saveMembers(d, sessionId, p.members as MemberInput[], integer(p.revision, "版本号"));
      return ok(res, await payload(e, sessionId));
    }
    if (req.method === "GET" && action === "stores") {
      const result = await searchStores(d, sessionId);
      return ok(res, { ...(await payload(e, sessionId)), warnings: result.warnings });
    }
    if (req.method === "POST" && action === "store") {
      await selectStore(d, sessionId, text(p.storeCode, "门店"), integer(p.revision, "版本号"));
      return ok(res, await payload(e, sessionId));
    }
    if (req.method === "POST" && action === "catalog") {
      const result = await refreshCatalog(d, sessionId, integer(p.revision, "版本号"), { priceUnit: "fen", detailCodes: DEMO_PRODUCTS.filter((p) => p.category === "combo").map((p) => p.code) });
      return ok(res, { ...(await payload(e, sessionId)), warnings: result.warnings });
    }
    if (req.method === "POST" && action === "facts/confirm-all") {
      if (p.confirmed !== true) throw new AppError("NEEDS_USER_INPUT", "请先查看并明确确认演示事实");
      if (integer(p.revision, "版本号") !== session.revision) throw new AppError("STALE_REVISION", "菜单或需求已变化，请刷新后重试");
      const confirmed = await confirmDemoFacts(e, sessionId);
      return ok(res, { ...(await payload(e, sessionId)), confirmed });
    }
    if (req.method === "POST" && action === "candidates") {
      // 演示目录的属性是预设数据，直接带来源提供给求解器，无需顾客逐项确认机器内部事实。
      const context = await getPlanningContext(d, sessionId);
      const existing = new Map(context.facts.map((f) => [`${f.subjectId}:${f.attribute}`, f]));
      for (const item of context.menu.items) for (const [attribute, value] of Object.entries(DEMO_FACTS[item.code] ?? {})) {
        const key = `${item.code}:${attribute}`;
        if (existing.get(key)?.status === "user_confirmed") continue;
        existing.set(key, { id: `${context.menu.id}:${key}`, subjectId: item.code, attribute: attribute as FactAttribute, value,
          status: "tool_supported", sourceRef: "本地演示目录预设属性（非真实门店认证）", confirmedBy: null, basis: "演示数据",
          menuSnapshotId: context.menu.id, observedAt: context.menu.fetchedAt });
      }
      context.facts = [...existing.values()];
      const result = await e.planning.generate(context);
      return ok(res, { ...(await payload(e, sessionId)), result });
    }
    if (req.method === "POST" && action === "quote") {
      const candidateId = text(p.candidateId, "候选方案");
      if (!(await e.planning.listActive(sessionId)).some((c) => c.id === candidateId)) throw missing("候选方案不属于当前点餐局或已失效");
      return ok(res, await e.checkout.quote(candidateId, integer(p.version, "候选版本")));
    }
    if (req.method === "POST" && action === "authorize") {
      const quoteId = text(p.quoteId, "报价");
      const quote = await e.checkoutRepo.getQuote(quoteId);
      if (!quote || quote.sessionId !== sessionId) throw missing("报价不属于当前点餐局");
      return ok(res, await e.checkout.authorize({
        quoteId, takeWayCode: text(p.takeWayCode, "取餐方式"),
        acknowledgedFactIds: Array.isArray(p.acknowledgedFactIds) ? p.acknowledgedFactIds.map(String) : [],
        organizerId: "web-organizer", userConfirmed: p.userConfirmed === true,
      }));
    }
    if (req.method === "POST" && action === "order") {
      const authorizationId = text(p.authorizationId, "授权");
      const authorization = await e.checkoutRepo.getAuthorization(authorizationId);
      const quote = authorization ? await e.checkoutRepo.getQuote(authorization.quoteId) : null;
      if (!quote || quote.sessionId !== sessionId) throw missing("授权不属于当前点餐局");
      return ok(res, await e.checkout.createOrder(authorizationId, text(p.idempotencyKey, "请求编号")));
    }
    const orderMatch = /^order\/([^/]+)$/.exec(action);
    if (req.method === "GET" && orderMatch) {
      const orderId = decodeURIComponent(orderMatch[1]!);
      const attempts = await e.checkoutRepo.listAttempts(["succeeded"]);
      let belongs = false;
      for (const attempt of attempts.filter((a) => a.orderId === orderId)) {
        const auth = await e.checkoutRepo.getAuthorization(attempt.authorizationId);
        const quote = auth ? await e.checkoutRepo.getQuote(auth.quoteId) : null;
        if (quote?.sessionId === sessionId) belongs = true;
      }
      if (!belongs) throw missing("订单不属于当前点餐局");
      return ok(res, await e.checkout.refreshOrder(orderId));
    }
    throw missing("接口不存在");
  } catch (error) {
    if (error instanceof AppError) return send(res, error.status, { ok: false, error: error.toJSON() });
    send(res, 500, { ok: false, error: { code: "INTERNAL", message: error instanceof Error ? error.message : "服务器内部错误", retryable: false, details: null } });
  }
}
