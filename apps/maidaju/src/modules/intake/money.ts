import { AppError } from "@/server/errors";

/**
 * 把用户明确输入的元金额转换为整数分。只用字符串运算，不做浮点乘法。
 * 接受 "150"、"150.5"、"150.50"、"¥150"、"150元"；
 * 模糊金额（"150左右"、"一百五"、"100-150"）抛 NEEDS_USER_INPUT。
 */
export function yuanToFen(input: string | number): number {
  const raw = String(input).trim().replace(/^[¥￥]/, "").replace(/元$/, "").trim();
  const m = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(raw);
  if (!m) {
    throw new AppError("NEEDS_USER_INPUT", `金额"${String(input)}"不明确，请输入如 150 或 150.50 的数字`);
  }
  const yuan = Number(m[1]);
  const fen = Number((m[2] ?? "").padEnd(2, "0"));
  return yuan * 100 + fen;
}

export function fenToYuanText(fen: number): string {
  const sign = fen < 0 ? "-" : "";
  const abs = Math.abs(fen);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
