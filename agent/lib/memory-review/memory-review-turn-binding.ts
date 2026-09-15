/**
 * Which memory-review batch a finishing Telegram turn belongs to.
 *
 * Export:
 * - `resolveMemoryReviewBatch`: marker first, durable turn binding second.
 */
import type { SessionContext } from "eve/context";

import { memoryReviewBatchId } from "./memory-review-session.js";
import { memoryReviewRepository } from "./memory-review-repository.js";

/**
 * Which batch, if any, the finished turn was reviewing.
 *
 * The marker in the current authorization answers this for the turn that started under it, and
 * still answers it when Eve replays that turn's terminal event after the batch was released. It
 * cannot answer for a turn resumed after a human answer, because the resumed turn carries the
 * authorization of that answer; the binding written at turn start is durable and covers that case.
 */
export async function resolveMemoryReviewBatch(ctx: {
  session: {
    auth: SessionContext["session"]["auth"];
    id: string;
    turn: { id: string };
  };
}): Promise<string | null> {
  const marked = memoryReviewBatchId(ctx);
  if (marked) return marked;
  return await memoryReviewRepository.batchIdForTurn({
    eveSessionId: ctx.session.id,
    eveTurnId: ctx.session.turn.id,
  });
}
