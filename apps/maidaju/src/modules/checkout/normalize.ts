// calculate-price / create-order / query-order 响应标准化。
// 真实响应结构未经验证：找不到可靠字段时一律 fail closed，不填 0、不猜。
import type { Fen, TakeWay } from "@/contracts";

const unwrap = (raw: unknown): any => {
  const r = raw as any;
  return r && typeof r === "object" && r.data && typeof r.data === "object" ? r.data : r;
};

const asFen = (v: unknown): Fen | null => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);

const PAYABLE_KEYS = ["realTotalAmount", "payableAmount", "totalAmount", "realPrice"] as const;
const ORIGINAL_KEYS = ["originalPrice", "originalTotalAmount", "totalOriginalAmount"] as const;

export type NormalizedPrice = {
  payableFen: Fen;
  originalFen: Fen | null;
  /** 按请求 items 顺序的行金额；结构对不上时为 null */
  lineAmountsFen: Fen[] | null;
  takeWayOptions: TakeWay[];
  payableField: string;
};

export function normalizePrice(raw: unknown, requestedCodes: string[]): NormalizedPrice | { error: string } {
  const d = unwrap(raw);
  if (!d || typeof d !== "object") return { error: "核价响应不是对象" };

  const payableField = PAYABLE_KEYS.find((k) => asFen(d[k]) != null);
  if (!payableField) return { error: "核价响应中未找到可识别的整数分实付字段" };
  const payableFen = asFen(d[payableField])!;
  const ok = ORIGINAL_KEYS.find((k) => asFen(d[k]) != null);
  const originalFen = ok ? asFen(d[ok]) : null;

  let lineAmountsFen: Fen[] | null = null;
  const list = d.productList ?? d.products ?? d.items;
  if (Array.isArray(list) && list.length === requestedCodes.length) {
    const amounts = list.map((p: any, i: number) =>
      p?.productCode === requestedCodes[i] ? asFen(p.realSubtotal ?? p.subtotal ?? p.originalSubtotal) : null,
    );
    if (amounts.every((a) => a != null)) lineAmountsFen = amounts as Fen[];
  }

  const twRaw = Array.isArray(d.takeWayList) ? d.takeWayList : [];
  const takeWayOptions: TakeWay[] = twRaw
    .filter((t: any) => t && typeof t.code === "string" && t.code)
    .map((t: any) => ({ code: String(t.code), label: String(t.label ?? t.name ?? t.desc ?? t.code) }));

  return { payableFen, originalFen, lineAmountsFen, takeWayOptions, payableField };
}

export function normalizeCreatedOrder(raw: unknown): { orderId: string; payUrl: string | null } | null {
  const d = unwrap(raw);
  const orderId = d?.orderId ?? d?.orderNo ?? d?.id;
  if (typeof orderId !== "string" && typeof orderId !== "number") return null;
  const pay = d?.payUrl ?? d?.payH5Url ?? d?.paymentUrl;
  return { orderId: String(orderId), payUrl: typeof pay === "string" && /^https:\/\//.test(pay) ? pay : null };
}

export function normalizeOrderStatus(raw: unknown): string | null {
  const d = unwrap(raw);
  const s = d?.orderStatusText ?? d?.statusText ?? d?.orderStatus ?? d?.status;
  return s == null ? null : String(s);
}
