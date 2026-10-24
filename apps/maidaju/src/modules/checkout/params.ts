// MCP 参数构建：按业务类型带条件字段；到店自取不传 beCode，外送带地址。
import { sha256Hex } from "@/lib/sha256";
import { CheckoutSnapshot, DiningContext, type OrderItem } from "@/contracts";
import { AppError } from "@/server/errors";

const FORBIDDEN_KEYS = ["beCode", "reservationDate", "gmServiceCode", "addressId", "withOrder", "remark"] as const;

/** 去掉本地字段（lineId），保留 MCP 认可的字段；未设置的可选字段不出现 */
export function toMcpItems(items: OrderItem[]) {
  return items.map(({ lineId: _lineId, ...rest }) => {
    const out: Record<string, unknown> = { productCode: rest.productCode, quantity: rest.quantity };
    if (rest.roundList) out.roundList = rest.roundList;
    if (rest.modification) out.modification = rest.modification;
    if (rest.couponId && rest.couponCode) {
      out.couponId = rest.couponId;
      out.couponCode = rest.couponCode;
    }
    return out;
  });
}

function baseArgs(ctx: DiningContext) {
  const c = DiningContext.parse(ctx); // 每种业务类型独立 strict 校验
  return { storeCode: c.storeCode, orderType: c.orderType, beType: c.beType,
    ...("beCode" in c ? { beCode: c.beCode } : {}), ...("gmServiceCode" in c ? { gmServiceCode: c.gmServiceCode } : {}) };
}

export function buildPriceArgs(s: CheckoutSnapshot) {
  const args = { ...baseArgs(s.context), items: toMcpItems(s.items), needTableware: s.needTableware };
  if (s.context.beType === 1) assertNoForbidden(args);
  return args;
}

export function buildCreateOrderArgs(s: CheckoutSnapshot, takeWayCode: string) {
  if (s.context.orderType === 1 && !takeWayCode) throw new AppError("NEEDS_USER_INPUT", "到店订单必须选择取餐方式");
  const args = { ...buildPriceArgs(s), ...(s.context.orderType === 1 ? { takeWayCode } : { addressId: "addressId" in s.context ? s.context.addressId : "" }) };
  if (s.context.beType === 1) assertNoForbidden(args);
  return args;
}

export function assertNoForbidden(args: Record<string, unknown>) {
  for (const k of FORBIDDEN_KEYS) {
    if (k in args) throw new AppError("VALIDATION", `首版到店请求不允许字段 ${k}`);
  }
}

/** 真实模式下拒绝任何模拟编码 */
export function assertModeConsistent(s: CheckoutSnapshot, transportMode: "mock" | "live") {
  if (s.mode !== transportMode) throw new AppError("MODE_MISMATCH", `快照模式 ${s.mode} 与当前 MCP 模式 ${transportMode} 不一致`);
  if (transportMode === "live") {
    const codes = collectCodes(s);
    const bad = codes.find((c) => c.startsWith("MOCK-"));
    if (bad) throw new AppError("MODE_MISMATCH", `真实链路拒绝模拟编码 ${bad}`);
  }
}

function collectCodes(s: CheckoutSnapshot): string[] {
  const out: string[] = [s.context.storeCode];
  for (const i of s.items) {
    out.push(i.productCode);
    if (i.couponCode) out.push(i.couponCode);
    for (const r of i.roundList ?? []) for (const c of r.comboItemList) {
      out.push(c.code);
      for (const v of c.modification?.values ?? []) out.push(v.code, v.key);
    }
    for (const v of i.modification?.values ?? []) out.push(v.code, v.key);
  }
  return out;
}

/** 稳定 JSON：对象键排序，数组保持顺序 */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonicalJson(x)}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

export const sha256 = (s: string) => sha256Hex(s);

/** 价格相关参数摘要：门店、业务类型、商品、数量、套餐、特调、券、餐具 */
export function cartHash(s: CheckoutSnapshot): string {
  return sha256(canonicalJson({ mode: s.mode, context: s.context, ...buildPriceArgs(s) }));
}

/** 确认摘要：在 cartHash 基础上纳入需求 revision、分配与已接受未知项 */
export function confirmDigest(s: CheckoutSnapshot, takeWayCode: string, acknowledgedFactIds: string[]): string {
  return sha256(
    canonicalJson({
      cart: cartHash(s),
      sessionRevision: s.sessionRevision,
      candidate: [s.candidateId, s.candidateVersion],
      assignments: s.assignments,
      takeWayCode,
      ack: [...acknowledgedFactIds].sort(),
    }),
  );
}

export function parseSnapshot(s: unknown): CheckoutSnapshot {
  const r = CheckoutSnapshot.safeParse(s);
  if (!r.success) throw new AppError("VALIDATION", "CheckoutSnapshot 不合法", false, r.error.issues);
  return r.data;
}
