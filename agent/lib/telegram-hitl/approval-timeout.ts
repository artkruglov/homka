/**
 * Unanswered Telegram HITL approval timeout resolution.
 *
 * Exports:
 * - `TimedOutApprovalClaim`: one leased request that outlived the confirmation window.
 * - `createApprovalTimeoutResolver`: dependency-injected sweep over expired requests.
 * - `approvalTimeoutContext`: model-facing explanation attached to the synthetic cancellation.
 *
 * Key constructs:
 * - Eve settles an approval by option id only, so the timeout reason travels as session context.
 * - The response carries the same freshly revalidated auth the interactive callback path delivers,
 *   because Eve replaces session auth with whatever a response supplies.
 * - A dead session is settled rather than retried: its parked turn can never resume.
 * - An approver whose role or space can no longer be proven is settled too, without a response:
 *   resuming a turn under an unprovable identity is forbidden, and a prompt that never closes
 *   leaves the turn parked and the person without either an answer or a warning.
 * - Every expired request of one session is cancelled in a single response: Eve 0.40.0 resolves a
 *   multi-request batch only from one delivery, and answers sent one at a time leave it parked.
 */
import type { SessionAuthContext } from "eve/context";
import type { Session } from "eve/channels";

import { TELEGRAM_HITL_APPROVAL_TIMEOUT_MS } from "../../config.js";

export interface TimedOutApprovalClaim {
  applicationSessionId: string;
  /**
   * Revalidated Telegram auth for the resumed turn; Eve overwrites session auth with it.
   * `null` means the approver can no longer be proven: the request is cancelled, never resumed.
   */
  auth: SessionAuthContext | null;
  eveSessionId: string;
  id: string;
  kind: "question" | "tool-approval";
  leaseToken: string;
  promptText: string;
  requestId: string;
  telegramChatId: string;
  telegramMessageId: string;
  toolName: string | null;
}

export interface ApprovalTimeoutRepository {
  claimExpired(now: Date, timeoutMilliseconds: number): Promise<TimedOutApprovalClaim[]>;
  completeTimeout(claim: TimedOutApprovalClaim, now: Date): Promise<boolean>;
  failTimeout(claim: TimedOutApprovalClaim, errorCode: string): Promise<void>;
}

export interface ApprovalTimeoutDependencies {
  attachSession(eveSessionId: string): Pick<Session, "respond">;
  finalizePrompt(claim: TimedOutApprovalClaim): Promise<void>;
  repository: ApprovalTimeoutRepository;
}

const TIMEOUT_RESPONSE_FAILED = "AGENT_APPROVAL_TIMEOUT_RESPONSE_FAILED";
const TIMEOUT_SETTLEMENT_FAILED = "AGENT_APPROVAL_TIMEOUT_SETTLEMENT_FAILED";
const TIMEOUT_LEASE_RELEASE_FAILED = "AGENT_APPROVAL_TIMEOUT_LEASE_RELEASE_FAILED";
const TIMEOUT_SESSION_INACTIVE = "AGENT_APPROVAL_TIMEOUT_SESSION_INACTIVE";
const TIMEOUT_PROMPT_FINALIZE_FAILED = "AGENT_APPROVAL_TIMEOUT_PROMPT_FINALIZE_FAILED";
const TIMEOUT_APPROVER_UNPROVABLE = "AGENT_APPROVAL_TIMEOUT_APPROVER_UNPROVABLE";
const TIMEOUT_MINUTES = Math.round(TELEGRAM_HITL_APPROVAL_TIMEOUT_MS / 60_000);
const NO_ANSWER_TEXT = "Пользователь не ответил на вопрос вовремя.";

export function approvalTimeoutContext(claim: TimedOutApprovalClaim): string {
  const subject = claim.kind === "question"
    ? "не ответил на заданный вопрос"
    : claim.toolName === null
    ? "не подтвердил запрошенное действие"
    : `не подтвердил действие «${claim.toolName}»`;
  return [
    `Пользователь ${subject} более ${TIMEOUT_MINUTES} мин, поэтому оно не выполнено.`,
    "Сообщи пользователю, что подтверждение не получено и действие не отработало, и продолжай работу как обычно.",
    "Не запрашивай подтверждение этого действия повторно, пока пользователь явно не попросит его выполнить.",
  ].join(" ");
}

/** Eve resolves an approval only by option id; a question has no option the user ever saw. */
function timeoutInputResponse(claim: TimedOutApprovalClaim) {
  return claim.kind === "question"
    ? { requestId: claim.requestId, text: NO_ANSWER_TEXT }
    : { optionId: "cancel", requestId: claim.requestId };
}

export function createApprovalTimeoutResolver(dependencies: ApprovalTimeoutDependencies) {
  return async function resolveTimedOutApprovals(now: Date): Promise<number> {
    const claims = await dependencies.repository.claimExpired(
      now,
      TELEGRAM_HITL_APPROVAL_TIMEOUT_MS,
    );
    let resolved = 0;
    for (const group of groupBySession(claims)) {
      resolved += await resolveSession(dependencies, group, now);
    }
    return resolved;
  };
}

/** Claims of one parked session travel in one response, in the order the sweep leased them. */
function groupBySession(claims: readonly TimedOutApprovalClaim[]): TimedOutApprovalClaim[][] {
  const groups = new Map<string, TimedOutApprovalClaim[]>();
  for (const claim of claims) {
    const group = groups.get(claim.eveSessionId);
    if (group) group.push(claim);
    else groups.set(claim.eveSessionId, [claim]);
  }
  return [...groups.values()];
}

async function releaseLease(
  dependencies: ApprovalTimeoutDependencies,
  claim: TimedOutApprovalClaim,
): Promise<void> {
  try {
    await dependencies.repository.failTimeout(claim, TIMEOUT_RESPONSE_FAILED);
  } catch (releaseError) {
    // The lease expires on its own; losing it must not abandon the rest of the leased batch.
    console.error(JSON.stringify({
      approvalId: claim.id,
      code: TIMEOUT_LEASE_RELEASE_FAILED,
      error: releaseError instanceof Error ? releaseError.message : String(releaseError),
    }));
  }
}

async function resolveSession(
  dependencies: ApprovalTimeoutDependencies,
  claims: readonly TimedOutApprovalClaim[],
  now: Date,
): Promise<number> {
  const finalizedPrompts = new Set<string>();
  const unprovable = claims.filter((claim) => claim.auth === null);
  const provable = claims.filter((claim) => claim.auth !== null);

  // A request whose approver lost the required role or space can never be answered on their behalf.
  // Closing it is the only outcome that keeps the promise: the action stays unexecuted, the prompt
  // stops offering buttons, and the session loses its rotation veto.
  if (unprovable.length > 0) {
    console.error(JSON.stringify({
      approvalIds: unprovable.map((claim) => claim.id),
      code: TIMEOUT_APPROVER_UNPROVABLE,
    }));
    await settleClaims(dependencies, unprovable, now, finalizedPrompts);
  }

  const first = provable[0];
  if (!first) return 0;
  let active: boolean;
  try {
    // Eve settles each original tool call exactly once. Cancel keeps the side effect unexecuted
    // while the persisted context carries the reason, which the approval outcome cannot express.
    const result = await dependencies.attachSession(first.eveSessionId).respond(
      provable.map(timeoutInputResponse),
      { auth: first.auth!, context: provable.map(approvalTimeoutContext) },
    );
    active = result.status === "accepted";
    if (!active) {
      // The parked turn is gone; settling the rows is the only way to release the rotation veto.
      console.error(JSON.stringify({
        approvalIds: provable.map((claim) => claim.id),
        code: TIMEOUT_SESSION_INACTIVE,
        eveSessionId: first.eveSessionId,
      }));
    }
  } catch (error) {
    // The leases are released so the next sweep retries; a frozen chat must never be the resting state.
    console.error(JSON.stringify({
      approvalIds: provable.map((claim) => claim.id),
      code: TIMEOUT_RESPONSE_FAILED,
      error: error instanceof Error ? error.message : String(error),
      eveSessionId: first.eveSessionId,
    }));
    for (const claim of provable) await releaseLease(dependencies, claim);
    return 0;
  }

  const settled = await settleClaims(dependencies, provable, now, finalizedPrompts);
  return active ? settled : 0;
}

/** Writes terminal state and rewrites each shared prompt once; one failure never abandons the batch. */
async function settleClaims(
  dependencies: ApprovalTimeoutDependencies,
  claims: readonly TimedOutApprovalClaim[],
  now: Date,
  finalizedPrompts: Set<string>,
): Promise<number> {
  let settledCount = 0;
  for (const claim of claims) {
    let settled: boolean;
    try {
      // A concurrent user tap wins the row; only the sweep that terminalizes it rewrites the prompt.
      settled = await dependencies.repository.completeTimeout(claim, now);
    } catch (error) {
      // One failed settlement must not abandon the rest of the leased batch.
      console.error(JSON.stringify({
        approvalId: claim.id,
        code: TIMEOUT_SETTLEMENT_FAILED,
        error: error instanceof Error ? error.message : String(error),
      }));
      continue;
    }
    if (!settled) continue;
    settledCount += 1;

    // Several requests of one step share one Telegram prompt; it is rewritten once.
    const promptKey = `${claim.telegramChatId} ${claim.telegramMessageId}`;
    if (finalizedPrompts.has(promptKey)) continue;
    finalizedPrompts.add(promptKey);
    try {
      await dependencies.finalizePrompt(claim);
    } catch (error) {
      // The approval is already terminal; a stale keyboard is cosmetic and must not retry the cancel.
      console.error(JSON.stringify({
        approvalId: claim.id,
        code: TIMEOUT_PROMPT_FINALIZE_FAILED,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }
  return settledCount;
}
