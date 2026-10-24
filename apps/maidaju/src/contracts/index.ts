// 冻结的共享契约（AI-3 维护）。变更需提 schema diff + 示例 + 迁移方式。
import { z } from "zod";

/** 金额一律为整数分 */
export const Fen = z.number().int().safe().nonnegative();
export type Fen = z.infer<typeof Fen>;

export const AppMode = z.enum(["mock", "live"]);
export type AppMode = z.infer<typeof AppMode>;

/** 首版仅到店自取：beType=1 / orderType=1，对象内不允许出现 beCode */
export const DiningContext = z
  .object({
    beType: z.literal(1),
    orderType: z.literal(1),
    storeCode: z.string().regex(/^\d+$/, "storeCode 必须全为数字"),
  })
  .strict();
export type DiningContext = z.infer<typeof DiningContext>;

export const ModificationValue = z
  .object({ code: z.string().min(1), key: z.string().min(1), quantity: z.number().int().positive() })
  .strict();
export type ModificationValue = z.infer<typeof ModificationValue>;

export const Modification = z.object({ values: z.array(ModificationValue).min(1) }).strict();

export const ComboItem = z
  .object({ code: z.string().min(1), quantity: z.number().int().positive(), modification: Modification.optional() })
  .strict();

export const Round = z.object({ round: z.string().min(1), comboItemList: z.array(ComboItem).min(1) }).strict();

export const OrderItem = z
  .object({
    lineId: z.string().min(1), // 本地行标识，不发往 MCP
    productCode: z.string().min(1),
    quantity: z.number().int().positive(),
    roundList: z.array(Round).optional(),
    modification: Modification.optional(),
    couponId: z.string().min(1).optional(),
    couponCode: z.string().min(1).optional(),
  })
  .strict()
  .refine((i) => !!i.couponId === !!i.couponCode, { message: "couponId 与 couponCode 必须同时给出" });
export type OrderItem = z.infer<typeof OrderItem>;

export const Assignment = z
  .object({
    lineId: z.string().min(1),
    componentPath: z.string().optional(), // 例如 "round:1/code:xxx"
    memberIds: z.array(z.string().min(1)).min(1),
    quantity: z.number().int().positive(),
    shared: z.boolean(),
  })
  .strict();
export type Assignment = z.infer<typeof Assignment>;

export const ConstraintCheck = z
  .object({
    memberId: z.string().nullable(),
    constraint: z.string(),
    status: z.enum(["pass", "pending", "fail"]),
    factIds: z.array(z.string()),
    reason: z.string(),
  })
  .strict();
export type ConstraintCheck = z.infer<typeof ConstraintCheck>;

/** AI-2 -> AI-3 交接快照 */
export const CheckoutSnapshot = z
  .object({
    sessionId: z.string(),
    sessionRevision: z.number().int().nonnegative(),
    candidateId: z.string(),
    candidateVersion: z.number().int().positive(),
    mode: AppMode,
    menuSnapshotId: z.string(),
    context: DiningContext,
    items: z.array(OrderItem).min(1),
    assignments: z.array(Assignment),
    memberIds: z.array(z.string()).min(1), // 固定成员顺序，用于尾差分配
    memberBudgetCapFen: z.record(z.string(), Fen.nullable()),
    totalBudgetFen: Fen.nullable(),
    needTableware: z.boolean(),
    hardConstraintStatus: z.enum(["pass", "pending", "fail"]),
    unresolvedFactIds: z.array(z.string()),
  })
  .strict();
export type CheckoutSnapshot = z.infer<typeof CheckoutSnapshot>;

export const TakeWay = z.object({ code: z.string().min(1), label: z.string() });
export type TakeWay = z.infer<typeof TakeWay>;

export type QuoteStatus = "verified" | "stale" | "failed";
export type Quote = {
  id: string;
  sessionId: string;
  candidateId: string;
  candidateVersion: number;
  sessionRevision: number;
  mode: AppMode;
  cartHash: string;
  status: QuoteStatus;
  payableFen: Fen;
  originalFen: Fen | null;
  lineAmountsFen: Record<string, Fen> | null; // lineId -> 行金额（服务端可提供时）
  memberAllocatedFen: Record<string, Fen> | null; // null = 待组织者确认分摊
  allocationNote: string;
  budgetOk: "pass" | "pending" | "fail";
  takeWayOptions: TakeWay[];
  checkedAt: string;
  expiresAt: string; // 本地安全窗口，不代表服务端价格锁定
  sourceRef: string;
};

export type OrderAuthorization = {
  id: string;
  quoteId: string;
  cartHash: string;
  confirmDigest: string;
  takeWayCode: string;
  acknowledgedFactIds: string[];
  organizerId: string;
  confirmedAt: string;
  consumedAt: string | null;
  invalidatedAt: string | null;
};

export type AttemptStatus = "prepared" | "sending" | "succeeded" | "rejected" | "outcome_unknown";
export type OrderAttempt = {
  id: string;
  authorizationId: string;
  idempotencyKey: string;
  requestDigest: string;
  status: AttemptStatus;
  orderId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Order = {
  orderId: string;
  attemptId: string;
  storeCode: string;
  payableFen: Fen;
  payUrl: string | null; // 仅使用服务端返回值
  serverStatus: string | null; // 原样展示 query-order 状态
  statusCheckedAt: string | null;
};

export const ErrorCode = z.enum([
  "NEEDS_USER_INPUT",
  "STALE_REVISION",
  "MENU_CHANGED",
  "FACT_PENDING",
  "BUDGET_EXCEEDED",
  "QUOTE_STALE",
  "ORDER_OUTCOME_UNKNOWN",
  "AUTH_INVALID",
  "MODE_MISMATCH",
  "CONSTRAINT_FAILED",
  "MCP_ERROR",
  "VALIDATION",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;
