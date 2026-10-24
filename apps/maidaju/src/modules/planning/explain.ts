// B5：候选解释。确定性模板为默认；LLM 只能改写措辞，输出需通过校验，否则回退模板。
import { z } from "zod";
import type { LlmProvider } from "../ports";
import { fenToYuanText } from "../intake/money";
import type { Candidate, Conflict } from "./types";

const STATUS_TEXT = { pass: "满足", pending: "待确认", fail: "未满足" } as const;
const STATUS_ICON = { pass: "✓", pending: "?", fail: "✗" } as const;

export const statusBadge = (s: keyof typeof STATUS_TEXT) => `${STATUS_ICON[s]} ${STATUS_TEXT[s]}`;

export function templateExplanation(c: Candidate, names: Map<string, string>, aliases: Map<string, string>): string {
  const lines: string[] = [];
  const price =
    c.estimatedTotalFen == null ? "价格待核价（菜单价格未核实）" : `估算 ¥${fenToYuanText(c.estimatedTotalFen)}（以核价为准）`;
  lines.push(`【${c.label}】${price}；硬约束：${statusBadge(c.hardConstraintStatus)}`);
  for (const [m, codes] of Object.entries(c.trays)) {
    lines.push(`- ${aliases.get(m) ?? m}：${codes.map((x) => names.get(x) ?? x).join("、") || "（无独享商品）"}`);
  }
  for (const s of c.shared) {
    lines.push(`- 共享：${names.get(s.code) ?? s.code} ×${s.quantity}（${s.memberIds.map((m) => aliases.get(m) ?? m).join("、")}）`);
  }
  const pend = c.checks.filter((x) => x.status !== "pass");
  if (pend.length) {
    lines.push("需要关注：");
    for (const x of pend) lines.push(`  ${statusBadge(x.status)} ${x.memberId ? (aliases.get(x.memberId) ?? x.memberId) + "：" : ""}${x.reason}`);
  }
  return lines.join("\n");
}

export function conflictText(c: Conflict): string {
  return `${c.reason}\n可选修改（需您选择后执行）：${c.suggestions.join(" / ")}`;
}

const LlmOut = z.object({ summary: z.string().min(1).max(400) }).strict();

export const EXPLAIN_SYSTEM_PROMPT = `你为多人点餐候选方案写一句中文差异说明。只输出 JSON：{"summary": "..."}。
规则：只能引用输入中给出的商品名、金额和检查状态；不得出现新的商品、价格或编码；
不得声称"全部满足"，除非输入 hardConstraintStatus 为 pass；不得给出过敏或健康安全承诺。`;

/** 校验 LLM 说明：不得出现未知商品名之外的价格数字/编码，不得与检查结果矛盾 */
export function validateExplanation(text: string, c: Candidate, names: Map<string, string>): boolean {
  if (/MOCK-|productCode|[A-Z0-9]{6,}/.test(text)) return false;
  if (c.hardConstraintStatus !== "pass" && /(全部|都已|均已)满足|完全满足/.test(text)) return false;
  if (/过敏|安全无忧|健康保证/.test(text)) return false;
  const allowedNums = new Set<string>();
  if (c.estimatedTotalFen != null) {
    allowedNums.add(fenToYuanText(c.estimatedTotalFen));
    allowedNums.add(String(Math.round(c.estimatedTotalFen / 100)));
  }
  for (const [, codes] of Object.entries(c.trays)) allowedNums.add(String(codes.length));
  allowedNums.add(String(Object.keys(c.trays).length));
  for (const n of text.match(/\d+(\.\d+)?/g) ?? []) if (!allowedNums.has(n)) return false;
  void names;
  return true;
}

export async function explainCandidate(
  c: Candidate,
  names: Map<string, string>,
  aliases: Map<string, string>,
  llm?: LlmProvider,
): Promise<{ text: string; source: "template" | "llm" }> {
  const template = templateExplanation(c, names, aliases);
  if (!llm) return { text: template, source: "template" };
  try {
    const raw = await llm.complete({
      system: EXPLAIN_SYSTEM_PROMPT,
      user: JSON.stringify({
        label: c.label,
        hardConstraintStatus: c.hardConstraintStatus,
        estimatedTotalYuan: c.estimatedTotalFen == null ? null : fenToYuanText(c.estimatedTotalFen),
        memberCount: Object.keys(c.trays).length,
        items: [...new Set(Object.values(c.trays).flat().concat(c.shared.map((s) => s.code)))].map((x) => names.get(x) ?? "未知商品"),
        nonPassChecks: c.checks.filter((x) => x.status !== "pass").map((x) => ({ status: x.status, reason: x.reason })),
      }),
    });
    const parsed = LlmOut.safeParse(JSON.parse(raw));
    if (!parsed.success || !validateExplanation(parsed.data.summary, c, names)) return { text: template, source: "template" };
    return { text: `${parsed.data.summary}\n\n${template}`, source: "llm" };
  } catch {
    return { text: template, source: "template" };
  }
}
