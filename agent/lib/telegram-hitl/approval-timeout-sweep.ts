/**
 * Minute-schedule trigger for the HITL approval timeout sweep.
 *
 * Exports:
 * - `APPROVAL_TIMEOUT_ROUTE`, `APPROVAL_TIMEOUT_TOKEN_HEADER`: internal route contract.
 * - `createApprovalTimeoutSweep`: dependency-injected trigger; missing config is not swallowed.
 * - `sweepTimedOutApprovals`: production trigger for the in-process internal route.
 *
 * Key constructs:
 * - The sweep runs behind an HTTP route because `attachSession` exists only in a route handler.
 */
import { timingSafeEqual } from "node:crypto";

import {
  AGENT_INTERNAL_SELF_BASE_URL,
  TELEGRAM_HITL_TIMEOUT_SWEEP_TIMEOUT_MS,
} from "../../config.js";

export const APPROVAL_TIMEOUT_ROUTE = "/internal/hitl-approval-timeout";
export const APPROVAL_TIMEOUT_TOKEN_HEADER = "x-osinara-internal-token";

export function requireInternalToken(): string {
  const token = process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN;
  if (!token) {
    throw new Error(
      "AGENT_INTERNAL_TOKEN_MISSING: Не задан внутренний токен для служебных маршрутов агента",
    );
  }
  return token;
}

/** Guards the private sweep route; a missing or wrong token is indistinguishable from no route. */
export function isInternalTokenAuthorized(presented: string | null, expected: string): boolean {
  if (presented === null) return false;
  const expectedBytes = Buffer.from(expected);
  const presentedBytes = Buffer.from(presented);
  return expectedBytes.length === presentedBytes.length &&
    timingSafeEqual(expectedBytes, presentedBytes);
}

export function createApprovalTimeoutSweep(dependencies: {
  fetch: typeof fetch;
  token(): string;
}) {
  return async function sweep(): Promise<void> {
    // Required config fails fast: a missing internal token must surface, not silently disable
    // the only mechanism that unfreezes a chat waiting on an unanswered confirmation.
    const token = dependencies.token();
    try {
      const response = await dependencies.fetch(
        new URL(APPROVAL_TIMEOUT_ROUTE, AGENT_INTERNAL_SELF_BASE_URL),
        {
          headers: { [APPROVAL_TIMEOUT_TOKEN_HEADER]: token },
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(TELEGRAM_HITL_TIMEOUT_SWEEP_TIMEOUT_MS),
        },
      );
      if (!response.ok) {
        throw new Error(
          `AGENT_APPROVAL_TIMEOUT_SWEEP_HTTP_FAILED: route returned HTTP ${response.status}`,
        );
      }
    } catch (error) {
      // The minute schedule is the boundary: report the cycle and let the next minute retry.
      console.error(JSON.stringify({
        code: "AGENT_APPROVAL_TIMEOUT_SWEEP_FAILED",
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  };
}

export const sweepTimedOutApprovals = createApprovalTimeoutSweep({
  fetch: (input, init) => fetch(input, init),
  token: requireInternalToken,
});
