/**
 * Durable one-query history snapshots for external-group scheduled runs.
 *
 * Exports:
 * - `ScheduledGroupHistorySnapshotResult`: prepared snapshot counts and fixed time window.
 * - `scheduledGroupHistorySnapshotRepository`: prepare once and read run-bound opaque chunks.
 *
 * Key constructs:
 * - One PostgreSQL statement reads the complete retained timeline window under one MVCC snapshot.
 * - Later model calls read only durable snapshot chunks and never query Telegram history again.
 */
import type { PoolClient } from "pg";

import { AppError } from "../app-error.js";
import { database } from "../database.js";
import {
  chunkScheduledGroupHistory,
  serializeScheduledGroupHistoryChunk,
  type ScheduledGroupHistoryEntry,
} from "./scheduled-group-history-chunker.js";

const TIMELINE_QUERY_LIMIT = 1_001;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

interface TimelineSnapshotRow {
  entries: ScheduledGroupHistoryEntry[];
  family_id: string;
  group_id: string;
  run_id: string;
  schedule_id: string;
  window_end: Date;
  window_start: Date;
}

interface SnapshotRecordRow {
  chunk_count: number;
  entry_count: number;
  window_end: Date;
  window_start: Date;
}

interface ReadChunkRow extends SnapshotRecordRow {
  current_cursor: string | null;
  entries: ScheduledGroupHistoryEntry[] | null;
  next_cursor: string | null;
}

export interface ScheduledGroupHistorySnapshotResult {
  chunkCount: number;
  entryCount: number;
  windowEnd: string;
  windowStart: string;
}

function snapshotResult(row: SnapshotRecordRow): ScheduledGroupHistorySnapshotResult {
  return {
    chunkCount: row.chunk_count,
    entryCount: row.entry_count,
    windowEnd: row.window_end.toISOString(),
    windowStart: row.window_start.toISOString(),
  };
}

async function existingSnapshot(client: Pick<PoolClient, "query">, input: {
  groupId: string;
  runId: string;
  scheduleId: string;
}): Promise<ScheduledGroupHistorySnapshotResult | null> {
  const result = await client.query<SnapshotRecordRow>(
    `SELECT entry_count, chunk_count, window_start, window_end
       FROM agent_schedule_history_snapshots
      WHERE run_id = $1 AND schedule_id = $2 AND group_id = $3`,
    [input.runId, input.scheduleId, input.groupId],
  );
  return result.rows[0] ? snapshotResult(result.rows[0]) : null;
}

export const scheduledGroupHistorySnapshotRepository = {
  async prepare(input: { groupId: string; runId: string; scheduleId: string }): Promise<ScheduledGroupHistorySnapshotResult> {
    if (
      !UUID_PATTERN.test(input.groupId) ||
      !UUID_PATTERN.test(input.runId) ||
      !UUID_PATTERN.test(input.scheduleId)
    ) {
      throw new AppError(
        "AGENT_SCHEDULE_HISTORY_SCOPE_DENIED",
        "Не удалось определить запуск автоматизации для снимка истории",
      );
    }
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const existing = await existingSnapshot(client, input);
      if (existing) {
        await client.query("COMMIT");
        return existing;
      }

      // Group administration uses group-first locking before cascading schedules; match that order.
      await client.query("SELECT 1 FROM telegram_groups WHERE id = $1 FOR SHARE", [input.groupId]);
      // Remaining source rows stay share-locked until chunks commit; terminal/revocation writes wait.
      const source = await client.query<TimelineSnapshotRow>(
        `WITH authorized AS (
         SELECT run.id AS run_id, schedule.id AS schedule_id, schedule.family_id,
                schedule.group_id, run.scheduled_for AS window_end,
                ((run.scheduled_for AT TIME ZONE schedule.timezone) -
                  make_interval(days => schedule.history_window_days))
                  AT TIME ZONE schedule.timezone AS window_start
           FROM agent_schedule_runs AS run
           JOIN agent_schedules AS schedule ON schedule.id = run.schedule_id
           JOIN telegram_groups AS telegram_group
             ON telegram_group.id = schedule.group_id
            AND telegram_group.family_id = schedule.family_id
            AND telegram_group.telegram_chat_id = schedule.telegram_chat_id
            AND telegram_group.telegram_chat_type = schedule.telegram_chat_type
            AND telegram_group.type = 'external'
           JOIN family_memberships AS membership
             ON membership.family_id = schedule.family_id
            AND membership.user_id = schedule.author_user_id
            AND membership.role = 'owner'
           WHERE run.id = $1 AND run.schedule_id = $2 AND schedule.id = $2
             AND schedule.group_id = $3 AND run.status = 'claimed' AND schedule.status = 'leased'
             AND schedule.scope = 'group' AND schedule.history_window_days IS NOT NULL
           FOR SHARE OF run, schedule, membership
       )
       SELECT authorized.run_id, authorized.schedule_id, authorized.family_id,
              authorized.group_id, authorized.window_start, authorized.window_end,
              COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                  'actor', message.actor_kind,
                  'content', message.content_text,
                  'displayName', message.sender_display_name,
                  'kind', message.message_kind,
                  'replyToSequence', message.reply_to_sequence_id::text,
                  'sentAt', message.sent_at,
                  'sequence', message.sequence_id::text,
                  'username', message.sender_username
                ) ORDER BY message.sequence_id)
                FROM (
                  SELECT * FROM telegram_group_messages
                   WHERE group_id = authorized.group_id
                     AND sent_at >= authorized.window_start
                     AND sent_at < authorized.window_end
                   ORDER BY sequence_id
                   LIMIT $4
                ) AS message
              ), '[]'::jsonb) AS entries
         FROM authorized`,
        [input.runId, input.scheduleId, input.groupId, TIMELINE_QUERY_LIMIT],
      );
      const snapshot = source.rows[0];
      if (!snapshot) {
        throw new AppError(
          "AGENT_SCHEDULE_HISTORY_SCOPE_DENIED",
          "Запуск больше не имеет доступа к истории внешней группы",
        );
      }
      const chunks = chunkScheduledGroupHistory(snapshot.entries);
      const inserted = await client.query(
        `INSERT INTO agent_schedule_history_snapshots
           (run_id, schedule_id, family_id, group_id, window_start, window_end,
            entry_count, chunk_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (run_id) DO NOTHING`,
        [
          snapshot.run_id,
          snapshot.schedule_id,
          snapshot.family_id,
          snapshot.group_id,
          snapshot.window_start,
          snapshot.window_end,
          snapshot.entries.length,
          chunks.length,
        ],
      );
      if (inserted.rowCount === 1) {
        for (const [ordinal, entries] of chunks.entries()) {
          await client.query(
            `INSERT INTO agent_schedule_history_chunks (run_id, ordinal, entries)
             VALUES ($1, $2, $3::jsonb)`,
            [snapshot.run_id, ordinal, JSON.stringify(entries)],
          );
        }
      }
      const prepared = await existingSnapshot(client, input);
      if (!prepared) {
        throw new AppError(
          "AGENT_SCHEDULE_HISTORY_SNAPSHOT_NOT_READY",
          "Снимок истории группы не был сохранён",
        );
      }
      await client.query("COMMIT");
      return prepared;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async readChunk(input: { cursor: string | null; groupId: string; runId: string }) {
    if (
      !UUID_PATTERN.test(input.groupId) ||
      !UUID_PATTERN.test(input.runId) ||
      (input.cursor !== null && !UUID_PATTERN.test(input.cursor))
    ) {
      throw new AppError(
        "AGENT_SCHEDULE_HISTORY_CURSOR_INVALID",
        "Не удалось продолжить чтение снимка истории группы",
      );
    }
    const result = await database().query<ReadChunkRow>(
      `WITH authorized AS (
         SELECT snapshot.run_id, snapshot.entry_count, snapshot.chunk_count,
                snapshot.window_start, snapshot.window_end
           FROM agent_schedule_history_snapshots AS snapshot
           JOIN agent_schedule_runs AS run ON run.id = snapshot.run_id
           JOIN agent_schedules AS schedule ON schedule.id = run.schedule_id
           JOIN telegram_groups AS telegram_group
             ON telegram_group.id = schedule.group_id
            AND telegram_group.family_id = schedule.family_id
            AND telegram_group.type = 'external'
           JOIN family_memberships AS membership
             ON membership.family_id = schedule.family_id
            AND membership.user_id = schedule.author_user_id
            AND membership.role = 'owner'
          WHERE snapshot.run_id = $1 AND snapshot.group_id = $2
            AND schedule.group_id = $2 AND schedule.scope = 'group'
            AND schedule.history_window_days IS NOT NULL
            AND schedule.status = 'leased' AND run.status IN ('dispatching', 'running')
       )
       SELECT authorized.entry_count, authorized.chunk_count,
              authorized.window_start, authorized.window_end,
              chunk.cursor_token::text AS current_cursor, chunk.entries,
              next_chunk.cursor_token::text AS next_cursor
         FROM authorized
         LEFT JOIN LATERAL (
           SELECT ordinal, cursor_token, entries
             FROM agent_schedule_history_chunks
            WHERE run_id = authorized.run_id
               AND (($3::uuid IS NULL AND ordinal = 0) OR cursor_token = $3)
            LIMIT 1
         ) AS chunk ON true
         LEFT JOIN agent_schedule_history_chunks AS next_chunk
           ON next_chunk.run_id = authorized.run_id AND next_chunk.ordinal = chunk.ordinal + 1`,
      [input.runId, input.groupId, input.cursor],
    );
    const row = result.rows[0];
    if (!row) {
      throw new AppError(
        "AGENT_SCHEDULE_HISTORY_SCOPE_DENIED",
        "Запуск больше не имеет доступа к снимку истории группы",
      );
    }
    if (row.entry_count > 0 && row.entries === null) {
      throw new AppError(
        "AGENT_SCHEDULE_HISTORY_CURSOR_INVALID",
        "Курсор не относится к текущему снимку истории группы",
      );
    }
    const entries = row.entries ?? [];
    return {
      done: row.next_cursor === null,
      entryCount: row.entry_count,
      nextCursor: row.next_cursor,
      timeline: serializeScheduledGroupHistoryChunk(entries),
      windowEnd: row.window_end.toISOString(),
      windowStart: row.window_start.toISOString(),
    };
  },
};
