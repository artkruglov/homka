/**
 * PostgreSQL signals for the owner's daily health digest.
 *
 * Exports:
 * - `OwnerHealthReport`: what the digest reports, all numbers from durable tables.
 * - `ownerHealthDigestRepository`: owners to notify, the report window, and the send claim.
 *
 * Key constructs:
 * - Every signal is read from tables that outlive a process: session rotations, failed ingress
 *   updates, review lanes and their heads, review batches, undelivered owner alerts, written memory,
 *   and unresolved reminder/schedule failures (counts only, including failures older than the window).
 *   Log-only events (sandbox reaps, repeat refusals, directive-only answers) are not here.
 * - The send claim is a row inserted before the Telegram call: a crash between claim and
 *   completion leaves a row without `sent_at`, which the next tick releases and retries.
 */
import { database } from "../database.js";
import type { QuietHours } from "../initiative/quiet-hours.js";
import { modelUsageRepository } from "./model-usage-repository.js";
import type { ModelSpendSummary } from "./model-spend.js";
import { readStorageHeadroom, type StorageHeadroom } from "./storage-headroom.js";

export interface OwnerHealthReport {
  alertDeliveryFailures: number;
  ingressFailures: { codes: { code: string; count: number }[]; count: number };
  /**
   * Дайджест уходит в личный чат владельца, то есть в его личную область, поэтому лейны приходят
   * счётчиками и кодами: название чата или человека было бы содержимым соседней области.
   */
  lanes: {
    blocked: { codes: { code: string; count: number }[]; count: number; waiting: number };
    lagging: { count: number; oldestAt: Date | null; waiting: number };
  };
  memoryWritten: { count: number; kind: string; scope: string }[];
  /** Вызовы модели за окно по всей установке: одна установка обслуживает одну семью. */
  modelSpend: ModelSpendSummary;
  proactiveFailures: { reminders: number; schedules: number };
  reviewBatches: { ambiguous: number; failed: number };
  rotations: { count: number; latestAt: Date | null };
  /** Место на диске и размер базы: откат требует двух копий дампа плюс образов. */
  storage: StorageHeadroom;
  windowStart: Date;
}

export interface OwnerHealthRecipient extends QuietHours {
  familyId: string;
  ownerTelegramUserId: string;
}

export const OWNER_HEALTH_LAGGING_MIN_WAITING = 50;
export const OWNER_HEALTH_LAGGING_MIN_AGE_MILLISECONDS = 6 * 60 * 60 * 1_000;

export const ownerHealthDigestRepository = {
  async recipients(): Promise<OwnerHealthRecipient[]> {
    const result = await database().query<{
      family_id: string;
      quiet_end: string | null;
      quiet_start: string | null;
      telegram_user_id: string;
      timezone: string | null;
    }>(
      `SELECT membership.family_id, owner.telegram_user_id, settings.timezone,
              to_char(settings.quiet_start, 'HH24:MI') AS quiet_start,
              to_char(settings.quiet_end, 'HH24:MI') AS quiet_end
         FROM family_memberships AS membership
         JOIN users AS owner ON owner.id = membership.user_id
         LEFT JOIN user_notification_settings AS settings ON settings.user_id = owner.id
        WHERE membership.role = 'owner' AND owner.telegram_user_id IS NOT NULL
        ORDER BY membership.family_id`,
    );
    // Часы не настроены: тихих часов нет, и пояс не нужен — сравнивать нечего.
    return result.rows.map((row) => ({
      familyId: row.family_id,
      ownerTelegramUserId: row.telegram_user_id,
      quietEnd: row.quiet_end,
      quietStart: row.quiet_start,
      timezone: row.timezone ?? "UTC",
    }));
  },

  async report(familyId: string, windowStart: Date, now: Date): Promise<OwnerHealthReport> {
    const client = database();
    const rotations = await client.query<{ count: string; latest_at: Date | null }>(
      `SELECT count(*)::text AS count, max(rotation_requested_at) AS latest_at
         FROM conversation_sessions
        WHERE family_id = $1 AND rotation_requested_at >= $2
          -- A new context the person asked for is not a failure; NULL predates the reason column.
          AND rotation_reason IS DISTINCT FROM 'user_requested'`,
      [familyId, windowStart],
    );
    // Ingress updates carry no family: a single installation serves one family in practice.
    const ingress = await client.query<{ code: string | null; count: string }>(
      `SELECT last_error_code AS code, count(*)::text AS count
         FROM telegram_ingress_updates
        WHERE status = 'failed' AND updated_at >= $1
        GROUP BY last_error_code ORDER BY count(*) DESC, last_error_code LIMIT 3`,
      [windowStart],
    );
    const ingressTotal = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM telegram_ingress_updates
        WHERE status = 'failed' AND updated_at >= $1`,
      [windowStart],
    );
    const lanes = await client.query<{
      diagnostic_code: string | null;
      head_status: string | null;
      oldest_at: Date | null;
      waiting: string;
    }>(
      `SELECT head.status AS head_status, head.diagnostic_code,
              (SELECT count(*) FROM telegram_group_messages AS message
                WHERE message.conversation_id = lane.conversation_id
                  AND COALESCE(message.message_thread_id, 0) = COALESCE(lane.message_thread_id, 0)
                  AND message.sequence_id > lane.processed_through_sequence)::text AS waiting,
              (SELECT min(message.sent_at) FROM telegram_group_messages AS message
                WHERE message.conversation_id = lane.conversation_id
                  AND COALESCE(message.message_thread_id, 0) = COALESCE(lane.message_thread_id, 0)
                  AND message.sequence_id > lane.processed_through_sequence) AS oldest_at
         FROM memory_review_lanes AS lane
         JOIN application_conversations AS conversation ON conversation.id = lane.conversation_id
         LEFT JOIN LATERAL (
           SELECT batch.status, batch.diagnostic_code FROM memory_review_batches AS batch
            WHERE batch.lane_id = lane.id
              AND batch.predecessor_sequence = lane.processed_through_sequence
            ORDER BY batch.created_at DESC LIMIT 1) AS head ON true
        WHERE conversation.family_id = $1`,
      [familyId],
    );
    const batches = await client.query<{ count: string; status: string }>(
      `SELECT batch.status, count(*)::text AS count
         FROM memory_review_batches AS batch
         JOIN application_conversations AS conversation ON conversation.id = batch.conversation_id
        WHERE conversation.family_id = $1 AND batch.created_at >= $2
          AND batch.status IN ('failed', 'ambiguous')
        GROUP BY batch.status`,
      [familyId, windowStart],
    );
    const alerts = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM memory_review_owner_alerts
        WHERE family_id = $1 AND created_at >= $2 AND status IN ('failed', 'ambiguous')`,
      [familyId, windowStart],
    );
    const written = await client.query<{ count: string; kind: string; scope: string }>(
      `SELECT scope::text, kind::text, count(*)::text AS count FROM memory_items_all
        WHERE family_id = $1 AND created_at >= $2
        GROUP BY scope, kind ORDER BY scope, kind`,
      [familyId, windowStart],
    );
    // A failed recurring reminder stays stopped until someone resolves it. Do not let it age out
    // of the daily report, or imply that a confirmed/ambiguous send means the household task is done.
    // Only family-scoped counts reach the owner; private content, titles and authors remain private.
    const proactive = await client.query<{ reminders: string; schedules: string }>(
      `SELECT
         (SELECT count(*)::text FROM reminders WHERE family_id = $1 AND status = 'failed') AS reminders,
         (SELECT count(*)::text FROM agent_schedules WHERE family_id = $1 AND status = 'failed') AS schedules`,
      [familyId],
    );
    const blocked: OwnerHealthReport["lanes"]["blocked"] = { codes: [], count: 0, waiting: 0 };
    const lagging: OwnerHealthReport["lanes"]["lagging"] = { count: 0, oldestAt: null, waiting: 0 };
    for (const lane of lanes.rows) {
      const waiting = Number(lane.waiting);
      if (lane.head_status === "failed" || lane.head_status === "ambiguous") {
        const code = lane.diagnostic_code === null
          ? lane.head_status
          : `${lane.head_status}/${lane.diagnostic_code}`;
        const seen = blocked.codes.find((entry) => entry.code === code);
        if (seen) seen.count += 1; else blocked.codes.push({ code, count: 1 });
        blocked.count += 1;
        blocked.waiting += waiting;
      } else if (
        waiting >= OWNER_HEALTH_LAGGING_MIN_WAITING && lane.oldest_at !== null &&
        now.getTime() - lane.oldest_at.getTime() >= OWNER_HEALTH_LAGGING_MIN_AGE_MILLISECONDS
      ) {
        lagging.count += 1;
        lagging.waiting += waiting;
        if (lagging.oldestAt === null || lane.oldest_at < lagging.oldestAt) {
          lagging.oldestAt = lane.oldest_at;
        }
      }
    }
    blocked.codes.sort((first, second) => first.code.localeCompare(second.code));
    const status = (name: string) => Number(batches.rows.find((row) => row.status === name)?.count ?? 0);
    return {
      alertDeliveryFailures: Number(alerts.rows[0]?.count ?? 0),
      ingressFailures: {
        codes: ingress.rows.map((row) => ({ code: row.code ?? "unknown", count: Number(row.count) })),
        count: Number(ingressTotal.rows[0]?.count ?? 0),
      },
      lanes: { blocked, lagging },
      memoryWritten: written.rows.map((row) => ({ count: Number(row.count), kind: row.kind, scope: row.scope })),
      modelSpend: await modelUsageRepository.summary(windowStart, now),
      proactiveFailures: {
        reminders: Number(proactive.rows[0]!.reminders),
        schedules: Number(proactive.rows[0]!.schedules),
      },
      reviewBatches: { ambiguous: status("ambiguous"), failed: status("failed") },
      rotations: { count: Number(rotations.rows[0]?.count ?? 0), latestAt: rotations.rows[0]?.latest_at ?? null },
      storage: await readStorageHeadroom(async () => {
        const size = await client.query<{ bytes: string }>(
          "SELECT pg_database_size(current_database())::text AS bytes",
        );
        return size.rows[0] ? Number(size.rows[0].bytes) : null;
      }),
      windowStart,
    };
  },

  /** Takes the day's send claim; false when the digest was already sent or is being sent. */
  async claim(familyId: string, digestDate: string, now: Date): Promise<boolean> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      // A claim older than an hour without a send belongs to a dispatcher that died mid-way.
      await client.query(
        `DELETE FROM owner_health_digests
          WHERE family_id = $1 AND digest_date = $2 AND sent_at IS NULL
            AND diagnostic_code IS NULL
            AND claimed_at < $3::timestamptz - interval '1 hour'`,
        [familyId, digestDate, now],
      );
      const inserted = await client.query(
        `INSERT INTO owner_health_digests (family_id, digest_date, claimed_at)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING family_id`,
        [familyId, digestDate, now],
      );
      await client.query("COMMIT");
      return inserted.rows.length === 1;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async complete(familyId: string, digestDate: string, now: Date, textLength: number): Promise<void> {
    await database().query(
      `UPDATE owner_health_digests SET sent_at = $3, text_length = $4
        WHERE family_id = $1 AND digest_date = $2`,
      [familyId, digestDate, now, textLength],
    );
  },

  async release(familyId: string, digestDate: string): Promise<void> {
    await database().query(
      `DELETE FROM owner_health_digests
        WHERE family_id = $1 AND digest_date = $2 AND sent_at IS NULL AND diagnostic_code IS NULL`,
      [familyId, digestDate],
    );
  },

  /** Неясный исход остаётся у строки навсегда: перезабрать её чистка брошенных уже не может. */
  async abandon(familyId: string, digestDate: string, diagnosticCode: string): Promise<void> {
    await database().query(
      `UPDATE owner_health_digests SET diagnostic_code = $3
        WHERE family_id = $1 AND digest_date = $2 AND sent_at IS NULL`,
      [familyId, digestDate, diagnosticCode],
    );
  },
};
