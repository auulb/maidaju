import { randomUUID } from "@/lib/ids";
import type { ErrorCode } from "@/contracts";

const HTTP: Partial<Record<ErrorCode, number>> = {
  STALE_REVISION: 409,
  QUOTE_STALE: 409,
  MENU_CHANGED: 409,
  AUTH_INVALID: 409,
  ORDER_OUTCOME_UNKNOWN: 409,
  VALIDATION: 400,
  NEEDS_USER_INPUT: 422,
  FACT_PENDING: 422,
  BUDGET_EXCEEDED: 422,
  CONSTRAINT_FAILED: 422,
  MODE_MISMATCH: 403,
  MCP_ERROR: 502,
};

/** 统一错误：{ code, message, retryable, details, traceId } */
export class AppError extends Error {
  readonly traceId = randomUUID();
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly retryable = false,
    readonly details: unknown = null,
  ) {
    super(message);
  }
  get status() {
    return HTTP[this.code] ?? 500;
  }
  toJSON() {
    return { code: this.code, message: this.message, retryable: this.retryable, details: this.details, traceId: this.traceId };
  }
}
