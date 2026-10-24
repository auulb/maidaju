// AI-2 逐人餐盘与候选规划 DTO。
// 跨模块传输对象（OrderItem / Assignment / ConstraintCheck / CheckoutSnapshot）来自 @/contracts（AI-3 维护）。
import type { AppMode, Assignment, ConstraintCheck, DiningContext, Fen, OrderItem } from "@/contracts";
import type { ItemCategory, Nutrition } from "../catalog/types";
import type { PriceBreakdown } from "./pricing";

export type Tri = "pass" | "pending" | "fail";

/** 主食判定：yes=有可靠依据；unknown=待确认；no=可靠依据表明不是主食 */
export type MainStatus = "yes" | "unknown" | "no";

/** 规划用标准化商品（由 PlanningContext 派生，不新增事实） */
export type PlanItem = {
  code: string;
  name: string;
  priceFen: Fen | null;
  category: ItemCategory;
  nutrition: Nutrition;
  roles: { main: number; drink: number; side: number; dessert: number };
  sugarFree: boolean;
  main: { status: MainStatus; factIds: string[]; sourceRef: string | null };
  /** 可作为加购/共享的非主食（工具分类或可靠事实表明非主食） */
  addon: boolean;
  /** 套餐：由详情默认项构建的 roundList；缺少详情或默认项时 buildable=false */
  roundList: OrderItem["roundList"];
  buildable: boolean;
  unbuildableReason: string | null;
  /** 每个硬约束属性：pass/pending/fail 及引用事实 */
  avoid: Record<string, { status: Tri; factIds: string[] }>;
};

export type SharedPick = { code: string; quantity: number; memberIds: string[] };

export type CandidateProfile = "budget" | "preference" | "sharing" | "variety" | "fitness" | "energy" | "manual" | "replan";

export const PROFILE_LABEL: Record<CandidateProfile, string> = {
  variety: "多元体验",
  fitness: "健身活力",
  energy: "能量满格",
  budget: "简洁省钱",
  preference: "偏好覆盖",
  sharing: "适度共享",
  manual: "手工调整",
  replan: "局部重配",
};

export type SearchStats = {
  elapsedMs: number;
  nodes: number;
  /** 任何一步按上限截断（餐盘数、beam 宽度、节点或时间预算） */
  truncated: boolean;
  limits: SearchOptions;
};

export type Candidate = {
  id: string;
  version: number;
  sessionId: string;
  sessionRevision: number;
  mode: AppMode;
  menuSnapshotId: string;
  context: DiningContext;
  needTableware: boolean;
  /** 固定成员顺序（尾差分配、展示） */
  memberOrder: string[];
  memberBudgetCapFen: Record<string, Fen | null>;
  totalBudgetFen: Fen | null;
  profile: CandidateProfile;
  label: string;
  /** memberId -> 独享商品 code 列表（每项数量 1） */
  trays: Record<string, string[]>;
  shared: SharedPick[];
  items: OrderItem[];
  assignments: Assignment[];
  checks: ConstraintCheck[];
  hardConstraintStatus: Tri;
  unresolvedFactIds: string[];
  /** 任一商品缺少可靠价格时为 null，绝不填 0 */
  estimatedTotalFen: Fen | null;
  estimatedMemberFen: Record<string, Fen> | null;
  priceSource: "estimate" | "unknown";
  metrics: PlanMetrics;
  pricing: PriceBreakdown | null;
  status: "active" | "superseded" | "stale";
  staleReason: string | null;
  search: SearchStats | null;
  /** 局部重配/手工调整相对上一版本的变动说明 */
  changes: { memberId: string | null; reason: string }[];
  createdAt: string;
};

export type PlanMetrics = {
  kcal: number; protein: number; fat: number; carb: number; sodium: number;
  distinct: number; quantity: number; sugarFreeDrinks: number;
  roles: { main: number; drink: number; side: number; dessert: number };
  estimated: boolean;
};

export type Conflict = {
  kind: "no_eligible_main" | "member_budget" | "total_budget" | "search_exhausted" | "structure";
  memberIds: string[];
  constraint: string;
  factIds: string[];
  reason: string;
  /** 最小修改建议；均需用户选择后执行，系统不自动应用 */
  suggestions: string[];
};

export type SearchOptions = {
  maxTraysPerMember: number;
  maxMainsConsidered: number;
  maxAddonsConsidered: number;
  beamWidth: number;
  maxNodes: number;
  timeBudgetMs: number;
  maxCandidates: number;
  sharingGroupSize: number;
};

export const DEFAULT_SEARCH: SearchOptions = {
  maxTraysPerMember: 8,
  maxMainsConsidered: 6,
  maxAddonsConsidered: 3,
  beamWidth: 50,
  maxNodes: 200_000,
  timeBudgetMs: 2_000,
  maxCandidates: 3,
  sharingGroupSize: 3,
};

export type GenerateResult = {
  candidates: Candidate[];
  conflicts: Conflict[];
  stats: SearchStats;
  /** 给用户的结论文案；搜索失败只说“当前搜索范围内未找到” */
  message: string;
};
