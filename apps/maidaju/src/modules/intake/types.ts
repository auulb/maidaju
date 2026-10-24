// AI-1 需求侧 DTO。PlanningContext 相关类型已提案并入 src/contracts（见 modules/AI1_HANDOFF.md）。
import { z } from "zod";
import { Fen } from "@/contracts";

/** 首版可识别的硬约束标签；其他要求只能进入 softPrefer 或问题 */
export const HardAvoid = z.enum(["spicy", "sugary_drink", "beef", "pork", "seafood"]);
export type HardAvoid = z.infer<typeof HardAvoid>;

export const HARD_AVOID_LABEL: Record<HardAvoid, string> = {
  spicy: "不吃辣",
  sugary_drink: "不喝含糖饮料",
  beef: "不吃牛肉",
  pork: "不吃猪肉",
  seafood: "不吃海鲜",
};

export const MemberRequirement = z
  .object({
    memberId: z.string().min(1),
    alias: z.string().trim().min(1).max(20),
    requiredMainCount: z.number().int().min(0).max(5),
    hardAvoid: z.array(HardAvoid),
    softPrefer: z.array(z.string().max(50)).max(10),
    budgetCapFen: Fen.nullable(),
    revision: z.number().int().nonnegative(),
  })
  .strict();
export type MemberRequirement = z.infer<typeof MemberRequirement>;

/** 解析草稿：只供组织者审阅，不直接写入硬约束 */
export type RequirementDraft = {
  memberCount: number | null;
  budgetFen: number | null;
  budgetKind: "total" | "perPerson" | null;
  memberUpdates: {
    alias: string;
    hardAvoid: HardAvoid[];
    softPrefer: string[];
    budgetCapFen: number | null;
  }[];
  unassignedRequirements: { type: HardAvoid; count: number }[];
  questions: string[];
  source: "rules" | "llm";
};
