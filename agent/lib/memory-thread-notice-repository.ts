/**
 * Durable exactly-once memory-thread creation notice boundary.
 *
 * Export:
 * - `memoryThreadNoticeRepository.takePending`: takes one notice in its verified private conversation.
 */
import { database } from "./database.js";
import { THREAD_NOTICE_DELIVERY_LEASE_MILLISECONDS } from "./memory-config.js";
import type { MemoryAuthorization } from "./memory-context.js";

export interface MemoryThreadCreationNotice {
  deliveryToken: string;
  purpose: string;
  text: string;
  threadId: string;
  threadRef: string;
  title: string;
}

export const memoryThreadNoticeRepository = {
  async takePending(
    auth: MemoryAuthorization,
    conversationId: string,
  ): Promise<MemoryThreadCreationNotice | null> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      // Telegram has no idempotency key. A crashed started send is terminally ambiguous and can
      // never become pending again, preventing a duplicate participant notice after restart.
      await client.query(
        `UPDATE memory_thread_creation_notices
         SET status = 'ambiguous', delivery_token = NULL,
             delivery_diagnostic_code = 'AGENT_MEMORY_THREAD_NOTICE_DELIVERY_AMBIGUOUS'
         WHERE status = 'started' AND delivery_started_at < $1`,
        [new Date(Date.now() - THREAD_NOTICE_DELIVERY_LEASE_MILLISECONDS)],
      );
      const result = await client.query<{
        delivery_token: string;
        purpose: string;
        thread_id: string;
        thread_ref: string;
        title: string;
      }>(
        `WITH candidate AS (
          SELECT notice.thread_id
          FROM memory_thread_creation_notices AS notice
          JOIN memory_threads AS thread ON thread.id = notice.thread_id
          JOIN application_conversations AS origin
            ON origin.id = notice.origin_conversation_id
           AND origin.telegram_group_id IS NULL
          WHERE notice.family_id = $1 AND notice.status = 'pending'
            AND notice.origin_conversation_id = $5 AND (
           (thread.scope = 'personal' AND 'personal' = ANY($2::memory_scope[])
             AND thread.scope_partition_key = $3) OR
           (thread.scope = 'family' AND 'family' = ANY($2::memory_scope[])) OR
           (thread.scope = 'group' AND 'group' = ANY($2::memory_scope[])
             AND thread.scope_partition_key = $4)
         ) ORDER BY notice.created_at, notice.thread_id
         FOR UPDATE OF notice SKIP LOCKED LIMIT 1
        ), updated AS (
          UPDATE memory_thread_creation_notices AS notice
          SET status = 'started', delivery_token = gen_random_uuid(), delivery_started_at = now()
          FROM candidate WHERE notice.thread_id = candidate.thread_id
          RETURNING notice.thread_id, notice.delivery_token::text
        )
         SELECT updated.thread_id, updated.delivery_token, thread.thread_ref, thread.title, thread.purpose
         FROM updated JOIN memory_threads AS thread ON thread.id = updated.thread_id`,
        [auth.familyId, auth.scopes, auth.userId, auth.groupId, conversationId],
      );
      await client.query("COMMIT");
      const row = result.rows[0];
      if (!row) return null;
      return {
        deliveryToken: row.delivery_token,
        purpose: row.purpose,
        text: `Начата новая нить памяти: «${row.title}». ${row.purpose}`,
        threadId: row.thread_id,
        threadRef: row.thread_ref,
        title: row.title,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async complete(threadId: string, deliveryToken: string, conversationId: string): Promise<void> {
    const result = await database().query(
      `UPDATE memory_thread_creation_notices
       SET status = 'presented', delivery_token = NULL, presented_at = now(),
           presented_conversation_id = $3
       WHERE thread_id = $1 AND status = 'started' AND delivery_token = $2`,
      [threadId, deliveryToken, conversationId],
    );
    if (!result.rowCount) {
      throw new Error(
        "AGENT_MEMORY_THREAD_NOTICE_STALE: Уведомление нити уже не ожидает подтверждения доставки",
      );
    }
  },

  async fail(
    threadId: string,
    deliveryToken: string,
    diagnosticCode: string,
    ambiguous: boolean,
  ): Promise<void> {
    await database().query(
      `UPDATE memory_thread_creation_notices
       SET status = $3, delivery_token = NULL, delivery_diagnostic_code = $4
       WHERE thread_id = $1 AND status = 'started' AND delivery_token = $2`,
      [threadId, deliveryToken, ambiguous ? "ambiguous" : "failed", diagnosticCode],
    );
  },
};
