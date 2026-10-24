// AI-1 门店/菜单/事实 DTO。
import { z } from "zod";
import { AppMode, DiningContext, Fen } from "@/contracts";
import { MemberRequirement } from "../intake/types";

export const StoreSummary = z.object({
  storeCode: z.string().regex(/^\d+$/),
  name: z.string(),
  address: z.string().nullable(),
  businessHours: z.string().nullable(),
  mode: AppMode,
  sourceRef: z.string(),
});
export type StoreSummary = z.infer<typeof StoreSummary>;

export const ItemCategory = z.enum(["main", "side", "drink", "dessert", "combo", "unknown"]);
export type ItemCategory = z.infer<typeof ItemCategory>;

export const CatalogItem = z.object({
  code: z.string().min(1),
  name: z.string(),
  /** 只有单位可核实时才填写；否则 null，绝不填 0 */
  priceFen: Fen.nullable(),
  priceRaw: z.unknown(),
  supportModify: z.boolean().nullable(),
  /** 工具返回的分类名原文；不从商品名推断 */
  toolCategoryName: z.string().nullable(),
  category: ItemCategory,
  sourceRef: z.string(),
});
export type CatalogItem = z.infer<typeof CatalogItem>;

export const StoreCoupon = z.object({
  couponId: z.string().min(1),
  couponCode: z.string().min(1),
  title: z.string(),
  sourceRef: z.string(),
});
export type StoreCoupon = z.infer<typeof StoreCoupon>;

export const DetailChoice = z.object({
  code: z.string(),
  name: z.string(),
  isDefault: z.boolean(),
  supportModify: z.boolean(),
});
export const DetailRound = z.object({
  round: z.string(),
  name: z.string(),
  choices: z.array(DetailChoice),
});
export const MealDetail = z.object({
  code: z.string(),
  name: z.string(),
  supportModify: z.boolean(),
  rounds: z.array(DetailRound),
  /** 原始响应保留给 AI-3 的 buildModification（selectedKey/unselectedKey） */
  raw: z.unknown(),
  sourceRef: z.string(),
  fetchedAt: z.string(),
});
export type MealDetail = z.infer<typeof MealDetail>;

export const MenuSnapshot = z.object({
  id: z.string(),
  mode: AppMode,
  context: DiningContext,
  items: z.array(CatalogItem),
  coupons: z.array(StoreCoupon),
  details: z.record(z.string(), MealDetail),
  fetchedAt: z.string(),
  sessionRevision: z.number().int(),
});
export type MenuSnapshot = z.infer<typeof MenuSnapshot>;

/** 事实属性：is_main 加上每个硬约束对应的 contains_* */
export const FactAttribute = z.enum([
  "is_main",
  "contains_spicy",
  "is_sugary_drink",
  "contains_beef",
  "contains_pork",
  "contains_seafood",
]);
export type FactAttribute = z.infer<typeof FactAttribute>;

export const Fact = z.object({
  id: z.string(),
  subjectId: z.string(),
  attribute: FactAttribute,
  value: z.boolean().nullable(),
  status: z.enum(["tool_supported", "user_confirmed", "pending", "conflict"]),
  sourceRef: z.string().nullable(),
  confirmedBy: z.string().nullable(),
  basis: z.string().nullable(),
  menuSnapshotId: z.string(),
  observedAt: z.string(),
});
export type Fact = z.infer<typeof Fact>;

/** AI-1 -> AI-2：只含已确认成员需求与带来源的目录 */
export const PlanningContext = z.object({
  sessionId: z.string(),
  sessionRevision: z.number().int(),
  mode: AppMode,
  totalBudgetFen: Fen,
  memberCount: z.number().int().min(6).max(20),
  needTableware: z.boolean(),
  members: z.array(MemberRequirement),
  menu: MenuSnapshot,
  facts: z.array(Fact),
});
export type PlanningContext = z.infer<typeof PlanningContext>;
