/**
 * Bounded cleanup for abandoned non-pending group tasks.
 *
 * Export:
 * - `sessionTaskCleanupRepository`: retires old/excess running tasks in bounded leased-job batches.
 */
import {
  SESSION_RETENTION_DAYS,
  SESSION_TASK_ABANDONED_DAYS,
  SESSION_TASK_MAX_ACTIVE_PER_GROUP_TOPIC,
  SESSION_TASK_SWEEP_BATCH_SIZE,
} from "../../config.js";
import { AppError } from "../app-error.js";
import { database } from "../database.js";

export const sessionTaskCleanupRepository = {
  async retireAbandonedTasks(now: Date): Promise<number> {
    const result = await database().query(
      `WITH ranked AS (
         SELECT id,
                row_number() OVER (
                  PARTITION BY group_id, telegram_forum_topic_id
                  ORDER BY last_activity_at DESC, id DESC
                ) AS group_rank
           FROM conversation_sessions
          WHERE kind = 'task' AND task_state = 'running'
            AND pending_operation = false AND retired_at IS NULL
            AND group_id IS NOT NULL
       ), candidates AS (
         SELECT session.id
           FROM conversation_sessions session
           JOIN ranked ON ranked.id = session.id
          WHERE session.last_activity_at <= $1::timestamptz - $2::integer * interval '1 day'
             OR ranked.group_rank > $3::integer
          ORDER BY session.last_activity_at, session.id
          LIMIT $4::integer
          FOR UPDATE OF session SKIP LOCKED
       ), retired AS (
         UPDATE conversation_sessions session
            SET task_state = 'failed',
                 retired_at = $1::timestamptz,
                 delete_after = $1::timestamptz + $5::integer * interval '1 day'
           FROM candidates
          WHERE session.id = candidates.id
         RETURNING session.id, session.family_id, session.kind, session.task_state
       ), removed_routes AS (
         DELETE FROM conversation_session_routes route
          USING retired
          WHERE route.session_id = retired.id
       ), audited AS (
         INSERT INTO audit_events (family_id, event_type, subject_id, metadata)
         SELECT family_id, 'session.abandoned_task_retired', id,
                jsonb_build_object('kind', kind::text, 'taskState', task_state::text)
           FROM retired
       )
       SELECT count(*)::integer AS retired_count FROM retired`,
      [
        now,
        SESSION_TASK_ABANDONED_DAYS,
        SESSION_TASK_MAX_ACTIVE_PER_GROUP_TOPIC,
        SESSION_TASK_SWEEP_BATCH_SIZE,
        SESSION_RETENTION_DAYS,
      ],
    );
    const row = result.rows[0] as { retired_count?: number } | undefined;
    if (typeof row?.retired_count !== "number") {
      throw new AppError(
        "AGENT_TASK_SWEEP_RESULT_INVALID",
        "Не удалось подтвердить очистку завершённых действий",
      );
    }
    return row.retired_count;
  },
};
