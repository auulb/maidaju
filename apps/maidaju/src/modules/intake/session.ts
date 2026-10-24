import { z } from "zod";
import { AppMode } from "@/contracts";
import { AppError } from "@/server/errors";
import type { DiningSessionRecord, IntakeDeps } from "../ports";
import { yuanToFen } from "./money";
import { MemberRequirement } from "./types";

export const MIN_MEMBERS = 1;
export const MAX_MEMBERS = 20;

const Yuan = z.union([z.string(), z.number()]);
/** 预算二选一：总预算或人均预算，统一换算为分 */
const BudgetInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("total"), yuan: Yuan }),
  z.object({ kind: z.literal("perPerson"), yuan: Yuan }),
]);

const OptText = (max: number) => z.string().trim().max(max).nullable().transform((v) => (v ? v : null));

export const CreateSessionInput = z.object({
  mode: AppMode,
  name: z.string().trim().min(1).max(40),
  memberCount: z.number().int().min(MIN_MEMBERS).max(MAX_MEMBERS),
  budget: BudgetInput,
  city: OptText(20).default(null),
  keyword: OptText(50).default(null),
  needTableware: z.boolean().default(false),
  beType: z.union([z.literal(1), z.literal(2), z.literal(5), z.literal(6)]).default(1),
  deliveryAddress: z.string().trim().max(120).default(""),
});
export type CreateSessionInput = z.input<typeof CreateSessionInput>;

export const UpdateSessionInput = CreateSessionInput.omit({ mode: true }).partial();
export type UpdateSessionInput = z.input<typeof UpdateSessionInput>;

function parseOrThrow<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const r = schema.safeParse(input);
  if (!r.success) throw new AppError("VALIDATION", "输入不合法", false, r.error.issues);
  return r.data;
}

function budgetToFen(budget: z.infer<typeof BudgetInput>, memberCount: number): number {
  const fen = yuanToFen(budget.yuan);
  if (fen <= 0) throw new AppError("NEEDS_USER_INPUT", "预算必须大于 0");
  return budget.kind === "total" ? fen : fen * memberCount;
}

export async function createSession(deps: IntakeDeps, input: CreateSessionInput): Promise<DiningSessionRecord> {
  const p = parseOrThrow(CreateSessionInput, input);
  const record: DiningSessionRecord = {
    id: deps.newId(),
    mode: p.mode,
    name: p.name,
    memberCount: p.memberCount,
    budgetFen: budgetToFen(p.budget, p.memberCount),
    beType: p.beType, deliveryAddress: p.deliveryAddress,
    city: p.city,
    keyword: p.keyword,
    needTableware: p.needTableware,
    selectedStore: null,
    revision: 1,
    updatedAt: deps.now(),
  };
  const saved = await deps.repo.saveSession(record, null);
  if (!saved) throw new AppError("STALE_REVISION", "点餐局 ID 冲突");
  return saved;
}

export async function loadSession(deps: IntakeDeps, id: string): Promise<DiningSessionRecord> {
  const s = await deps.repo.getSession(id);
  // 契约暂无 NOT_FOUND，已在交接文档中提案
  if (!s) throw new AppError("VALIDATION", "点餐局不存在", false, { notFound: true, sessionId: id });
  return s;
}

/** 写入并递增 revision；revision 不匹配返回 409，不静默覆盖 */
export async function commitSession(
  deps: IntakeDeps,
  current: DiningSessionRecord,
  patch: Partial<DiningSessionRecord>,
  expectedRevision: number,
): Promise<DiningSessionRecord> {
  if (current.revision !== expectedRevision) {
    throw new AppError("STALE_REVISION", "点餐局已被修改，请刷新后重试", false, { currentRevision: current.revision });
  }
  const next: DiningSessionRecord = { ...current, ...patch, id: current.id, mode: current.mode, revision: current.revision + 1, updatedAt: deps.now() };
  const saved = await deps.repo.saveSession(next, expectedRevision);
  if (!saved) throw new AppError("STALE_REVISION", "点餐局已被修改，请刷新后重试");
  return saved;
}

export async function updateSession(
  deps: IntakeDeps,
  id: string,
  input: UpdateSessionInput,
  expectedRevision: number,
): Promise<DiningSessionRecord> {
  const current = await loadSession(deps, id);
  const p = parseOrThrow(UpdateSessionInput, input);
  const memberCount = p.memberCount ?? current.memberCount;
  const patch: Partial<DiningSessionRecord> = {};
  if (p.name !== undefined) patch.name = p.name;
  if (p.memberCount !== undefined) patch.memberCount = p.memberCount;
  if (p.budget !== undefined) patch.budgetFen = budgetToFen(p.budget, memberCount);
  if (p.city !== undefined) patch.city = p.city;
  if (p.keyword !== undefined) patch.keyword = p.keyword;
  if (p.needTableware !== undefined) patch.needTableware = p.needTableware;
  if (p.beType !== undefined) patch.beType = p.beType;
  if (p.deliveryAddress !== undefined) patch.deliveryAddress = p.deliveryAddress;

  const saved = await commitSession(deps, current, patch, expectedRevision);
  await deps.invalidation.invalidate(id, "session_changed", saved.revision);
  return saved;
}

const MembersInput = z.array(MemberRequirement.omit({ revision: true }));
export type MemberInput = z.input<typeof MembersInput>[number];

/**
 * 保存组织者已确认的成员需求（整体替换）。
 * 成员数必须等于人数；代号与 memberId 不可重复；个人上限不得超过整局预算。
 */
export async function saveMembers(
  deps: IntakeDeps,
  sessionId: string,
  input: MemberInput[],
  expectedRevision: number,
): Promise<{ session: DiningSessionRecord; members: MemberRequirement[] }> {
  const current = await loadSession(deps, sessionId);
  const list = parseOrThrow(MembersInput, input);
  if (list.length !== current.memberCount) {
    throw new AppError("NEEDS_USER_INPUT", `成员数量 ${list.length} 与点餐局人数 ${current.memberCount} 不一致`);
  }
  if (new Set(list.map((m) => m.memberId)).size !== list.length || new Set(list.map((m) => m.alias)).size !== list.length) {
    throw new AppError("NEEDS_USER_INPUT", "成员代号或 ID 重复");
  }
  for (const m of list) {
    if (m.budgetCapFen !== null && m.budgetCapFen > current.budgetFen) {
      throw new AppError("NEEDS_USER_INPUT", `${m.alias} 的个人上限超过整局预算`);
    }
  }
  const session = await commitSession(deps, current, {}, expectedRevision);
  const members = list.map((m) => ({ ...m, hardAvoid: [...new Set(m.hardAvoid)], revision: session.revision }));
  await deps.repo.replaceMembers(sessionId, members);
  await deps.invalidation.invalidate(sessionId, "members_changed", session.revision);
  return { session, members };
}
