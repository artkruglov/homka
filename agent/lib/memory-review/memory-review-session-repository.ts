/**
 * Dedicated application-session storage for one-shot memory-review turns.
 *
 * Export:
 * - `memoryReviewSessionRepository`: creates and retires explicitly batch-linked Eve sessions.
 */
import { SESSION_RETENTION_DAYS } from "../../config.js";
import { AppError } from "../app-error.js";
import { database } from "../database.js";
import type { PreparedSession } from "../sessions/session-repository.js";
import { resolveSpaceAccess } from "../spaces/space-access.js";
import { resolveTurnSpaceContext } from "../spaces/turn-space-selection.js";
import type { MemoryReviewClaim } from "./memory-review-repository.js";

export const memoryReviewSessionRepository = {
  async prepare(batch: MemoryReviewClaim, now: Date): Promise<PreparedSession> {
    const continuationToken = `memory-review:${batch.batchId}`;
    // Проверка памяти пишет записи, поэтому её ход обязан принадлежать той же области, что и сам
    // разговор: иначе после включения режима он остановится на границе инструментов.
    const space = await resolveReviewSpace(batch);
    const result = await database().query<{
      id: string;
      thread_id: string;
    }>(
      `INSERT INTO conversation_sessions
         (thread_id, generation, family_id, group_id, owner_user_id, scope, kind, task_state,
           telegram_forum_topic_id, conversation_key, continuation_token,
           started_at, last_activity_at, memory_review_batch_id, space_id, space_policy_version)
        VALUES (gen_random_uuid(), 0, $1, $2, $8, $3, 'proactive', 'running', $4,
                $5, $5, $6, $6, $7, $9, $10)
        ON CONFLICT (memory_review_batch_id) WHERE memory_review_batch_id IS NOT NULL
        DO UPDATE SET last_activity_at = EXCLUDED.last_activity_at
          WHERE conversation_sessions.retired_at IS NULL
            AND conversation_sessions.kind = 'proactive'
            AND conversation_sessions.eve_session_id IS NULL
        RETURNING id, thread_id`,
      [batch.familyId, batch.groupId, batch.scope, batch.messageThreadId,
        continuationToken, now, batch.batchId,
        batch.scope === "personal" ? batch.ownerUserId : null,
        space?.spaceId ?? null, space?.policyVersion ?? null],
    );
    const row = result.rows[0];
    if (!row) throw new AppError(
      "AGENT_MEMORY_REVIEW_SESSION_CREATE_FAILED",
      "Не удалось создать контекст проверки памяти",
    );
    return {
      continuationToken,
      generation: 0,
      id: row.id,
      rotated: false,
      sandboxSessionId: row.thread_id,
      ...(space === null ? {} : { spacePolicy: space }),
    };
  },

  async retireUnstarted(
    batch: MemoryReviewClaim,
    applicationSessionId: string,
  ): Promise<void> {
    const result = await database().query(
      `UPDATE conversation_sessions
          SET pending_operation = false, task_state = 'failed', retired_at = now(),
              delete_after = now() + $2 * interval '1 day'
        WHERE id = $1 AND retired_at IS NULL AND kind = 'proactive'
          AND memory_review_batch_id = $3 AND eve_session_id IS NULL
          AND EXISTS (
            SELECT 1 FROM memory_review_batches AS batch
             WHERE batch.id = $3 AND batch.status = 'leased' AND batch.lease_token = $4
               AND batch.application_session_id IS NULL
          )`,
      [applicationSessionId, SESSION_RETENTION_DAYS, batch.batchId, batch.leaseToken],
    );
    // A lost lease transfers ownership of the reused session; the stale worker must not retire it.
    if (result.rowCount === 0) return;
  },
};

/** Область пакета берётся из того же чата, к которому он относится, и подтверждается под блокировкой. */
async function resolveReviewSpace(
  batch: MemoryReviewClaim,
): Promise<{ policyVersion: number; spaceId: string; title: string } | null> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const context = await resolveTurnSpaceContext(client, {
      chatType: batch.groupId === null ? "private" : "supergroup",
      familyId: batch.familyId,
      groupId: batch.groupId,
      userId: batch.ownerUserId,
    });
    if (context === null) return null;
    const access = await resolveSpaceAccess(client, context);
    return { policyVersion: access.policyVersion, spaceId: access.spaceId, title: access.title };
  } finally {
    try { await client.query("ROLLBACK"); } finally { client.release(); }
  }
}
