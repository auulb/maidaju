/**
 * MCP 响应标准化。真实返回结构尚未验证（文档第 0 节），因此：
 * - 只读取明确存在的字段，不从商品名推断分类、辣度、糖分；
 * - 价格单位未核实前 priceFen=null，原值保留在 priceRaw；
 * - 无法识别的结构返回空列表并附带 warnings，由调用方展示，不伪造数据。
 */
import type { AppMode } from "@/contracts";
import { Nutrition, type CatalogItem, type ItemCategory, type MealDetail, type StoreCoupon, type StoreSummary } from "./types";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null);
const bool = (v: unknown): boolean | null => (v === true || v === 1 || v === "1" ? true : v === false || v === 0 || v === "0" ? false : null);
const first = (o: Obj, keys: string[]) => {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
};

/** 深度遍历，收集满足谓词的对象及其路径和最近的分类名 */
function collect(root: unknown, pred: (o: Obj) => boolean, maxNodes = 20_000) {
  const out: { obj: Obj; path: string; parentName: string | null }[] = [];
  let visited = 0;
  const walk = (v: unknown, path: string, parentName: string | null) => {
    if (++visited > maxNodes) return;
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`, parentName));
    if (!isObj(v)) return;
    if (pred(v)) {
      out.push({ obj: v, path, parentName });
      return;
    }
    const groupName = str(first(v, ["categoryName", "menuName", "name", "title"]));
    for (const [k, child] of Object.entries(v)) {
      if (typeof child === "object" && child !== null) walk(child, path ? `${path}.${k}` : k, Array.isArray(child) ? groupName ?? parentName : parentName);
    }
  };
  walk(root, "", null);
  return out;
}

export type Normalized<T> = { items: T[]; warnings: string[] };

export function normalizeStores(data: unknown, mode: AppMode, snapshotRef: string): Normalized<StoreSummary> {
  const hits = collect(data, (o) => str(o.storeCode) !== null);
  const warnings: string[] = [];
  const seen = new Set<string>();
  const items: StoreSummary[] = [];
  for (const h of hits) {
    const code = str(h.obj.storeCode)!;
    if (!/^\d+$/.test(code)) {
      warnings.push(`忽略非数字 storeCode（${h.path}）`);
      continue;
    }
    if (seen.has(code)) continue;
    seen.add(code);
    items.push({
      storeCode: code,
      name: str(first(h.obj, ["storeName", "name", "shopName"])) ?? `门店 ${code}`,
      address: str(first(h.obj, ["address", "storeAddress", "addr"])),
      businessHours: str(first(h.obj, ["businessHours", "openTime", "businessTime"])),
      mode,
      sourceRef: `${snapshotRef}#${h.path}`,
    });
  }
  if (!items.length) warnings.push("响应中未识别到门店（storeCode）");
  return { items, warnings };
}

/** 仅当工具返回明确的类型字段时才映射；分类名文字不参与推断 */
function categoryFromTool(o: Obj): ItemCategory {
  const t = str(first(o, ["productType", "type"]));
  return t && ["main", "side", "drink", "dessert", "combo"].includes(t) ? t as ItemCategory : "unknown";
}

export type PriceUnit = "fen" | "yuan" | null;

function priceToFen(raw: unknown, unit: PriceUnit): number | null {
  if (unit === null) return null;
  const n = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+(\.\d{1,2})?$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  if (unit === "fen") return Number.isInteger(n) ? n : null;
  // 元 -> 分：按字符串计算避免浮点误差
  const [y, f = ""] = String(raw).split(".");
  return Number(y) * 100 + Number(f.padEnd(2, "0"));
}

export function normalizeMeals(data: unknown, snapshotRef: string, priceUnit: PriceUnit): Normalized<CatalogItem> {
  const hits = collect(data, (o) => str(first(o, ["code", "productCode"])) !== null && str(first(o, ["name", "productName"])) !== null);
  const warnings: string[] = [];
  const byCode = new Map<string, CatalogItem>();
  for (const h of hits) {
    const code = str(first(h.obj, ["code", "productCode"]))!;
    if (byCode.has(code)) continue;
    const cardRequired = h.obj.card_required === true || String(h.obj.discountType ?? "").includes("随单购");
    const priceRaw = (cardRequired ? h.obj.originalPrice : first(h.obj, ["price", "currentPrice", "salePrice"])) ?? null;
    byCode.set(code, {
      code,
      name: str(first(h.obj, ["name", "productName"]))!,
      priceFen: priceToFen(priceRaw, priceUnit),
      priceRaw,
      nutrition: Nutrition.safeParse(h.obj.nutrition).success ? Nutrition.parse(h.obj.nutrition) : undefined,
      supportModify: bool(h.obj.supportModify),
      toolCategoryName: h.parentName,
      category: categoryFromTool(h.obj),
      sourceRef: `${snapshotRef}#${h.path}`,
    });
  }
  const items = [...byCode.values()];
  if (!items.length) warnings.push("响应中未识别到在售商品（code + name）");
  if (priceUnit === null && items.some((i) => i.priceRaw !== null)) warnings.push("菜单价格单位未核实，估算价暂不可用，以核价为准");
  return { items, warnings };
}

export function normalizeCoupons(data: unknown, snapshotRef: string): Normalized<StoreCoupon> {
  const hits = collect(data, (o) => str(o.couponId) !== null && str(o.couponCode) !== null);
  const items = hits.map((h) => ({
    couponId: str(h.obj.couponId)!,
    couponCode: str(h.obj.couponCode)!,
    title: str(first(h.obj, ["title", "couponName", "name"])) ?? "未命名优惠券",
    sourceRef: `${snapshotRef}#${h.path}`,
  }));
  return { items, warnings: [] };
}

export function normalizeMealDetail(data: unknown, code: string, snapshotRef: string, fetchedAt: string): MealDetail {
  const root = isObj(data) && isObj(data.data) ? data.data : isObj(data) ? data : {};
  const roundsRaw = first(root, ["rounds", "roundList", "comboRounds"]);
  const rounds = Array.isArray(roundsRaw)
    ? roundsRaw.filter(isObj).map((r, i) => {
        const choicesRaw = first(r, ["choices", "comboItemList", "items"]);
        return {
          round: str(first(r, ["round", "roundId"])) ?? String(i + 1),
          name: str(first(r, ["name", "roundName"])) ?? `第 ${i + 1} 项`,
          choices: Array.isArray(choicesRaw)
            ? choicesRaw.filter(isObj).map((c) => ({
                code: str(first(c, ["code", "productCode"])) ?? "",
                name: str(first(c, ["name", "productName"])) ?? "",
                isDefault: bool(c.isDefault) === true,
                supportModify: bool(c.supportModify) === true,
              })).filter((c) => c.code)
            : [],
        };
      })
    : [];
  return {
    code,
    name: str(first(root, ["name", "productName"])) ?? code,
    supportModify: bool(root.supportModify) === true,
    rounds,
    raw: data,
    sourceRef: snapshotRef,
    fetchedAt,
  };
}

/** UI 展示规则（文档 1.4-3/4）：可特调标注 + 默认搭配摘要 */
export function displayName(name: string, supportModify: boolean | null) {
  return supportModify ? `${name}【可特调】` : name;
}
export function defaultSelectionSummary(d: MealDetail): string[] {
  return d.rounds.map((r) => {
    const def = r.choices.filter((c) => c.isDefault).map((c) => displayName(c.name, c.supportModify));
    return `${r.name}：${def.length ? def.join("、") : "未返回默认项"}`;
  });
}
