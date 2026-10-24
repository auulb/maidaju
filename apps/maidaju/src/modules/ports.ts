/**
 * AI-1 依赖的外部端口。实现由 AI-3 提供：
 * - tools: AI-3 的 ToolRegistry（白名单 + tools/list 映射）。AI-1 不自建连接、不读 token。
 * - repo: AI-3 的持久化层（Prisma）。src/modules/intake/memory-repo.ts 只用于测试/本地开发。
 */
import type { AppMode } from "@/contracts";
import type { LogicalTool, ToolResult } from "@/server/mcp/transport";
import type { MemberRequirement } from "./intake/types";
import type { Fact, MenuSnapshot, StoreSummary } from "./catalog/types";

/** AI-1 只允许使用的只读工具 */
export type ReadOnlyTool = Extract<LogicalTool, "queryNearbyStores" | "queryMeals" | "queryMealDetail" | "queryStoreCoupons">;

export interface ToolCaller {
  readonly mode: AppMode;
  call(tool: ReadOnlyTool, args: Record<string, unknown>): Promise<ToolResult>;
}

export interface LlmProvider {
  complete(input: { system: string; user: string }): Promise<string>;
}

export type DiningSessionRecord = {
  id: string;
  mode: AppMode;
  name: string;
  memberCount: number;
  budgetFen: number;
  beType?: 1 | 2 | 5 | 6;
  deliveryAddress?: string;
  city: string | null;
  keyword: string | null;
  needTableware: boolean;
  selectedStore: StoreSummary | null;
  revision: number;
  updatedAt: string;
};

export type InvalidationReason = "session_changed" | "members_changed" | "store_changed" | "menu_refreshed" | "fact_confirmed";

/** AI-2/AI-3 注册：清理候选、报价、授权 */
export interface InvalidationSink {
  invalidate(sessionId: string, reason: InvalidationReason, newRevision: number): Promise<void>;
}

export interface IntakeRepository {
  getSession(id: string): Promise<DiningSessionRecord | null>;
  /** 乐观锁：expectedRevision 不匹配返回 null；null 表示新建 */
  saveSession(next: DiningSessionRecord, expectedRevision: number | null): Promise<DiningSessionRecord | null>;
  getMembers(sessionId: string): Promise<MemberRequirement[]>;
  replaceMembers(sessionId: string, members: MemberRequirement[]): Promise<void>;
  getStoreSearch(sessionId: string): Promise<StoreSummary[]>;
  saveStoreSearch(sessionId: string, stores: StoreSummary[]): Promise<void>;
  getMenuSnapshot(sessionId: string): Promise<MenuSnapshot | null>;
  saveMenuSnapshot(sessionId: string, snapshot: MenuSnapshot | null): Promise<void>;
  /** 只持久化用户确认/冲突记录；pending 与工具事实由快照派生 */
  getFactConfirmations(sessionId: string): Promise<Fact[]>;
  replaceFactConfirmations(sessionId: string, facts: Fact[]): Promise<void>;
}

export type IntakeDeps = {
  repo: IntakeRepository;
  tools: ToolCaller;
  invalidation: InvalidationSink;
  now: () => string;
  newId: () => string;
  llm?: LlmProvider;
};
