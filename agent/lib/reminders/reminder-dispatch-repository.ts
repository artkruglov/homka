/**
 * Durable reminder dispatch queue boundary.
 *
 * Exports:
 * - `ClaimedReminder`: leased, authorization-revalidated Telegram delivery.
 * - `reminderDispatchRepository`: claim, side-effect marker, completion, and terminal failure.
 */
import type { PoolClient } from "pg";

import { checkLinkedReminderBeforeDispatch, linkedTaskActive } from "./task-reminder-link.js";
import { AppError, isAppError } from "../app-error.js";
import { isSpaceDestinationProven } from "../spaces/space-destination.js";
import { database } from "../database.js";
import { quietHoursClause } from "../initiative/quiet-hours.js";
import {
  type ProactiveDeliveryReceipt,
  recordProactiveDelivery,
} from "../proactive-deliveries/proactive-delivery-repository.js";
import {
  REMINDER_DESTINATION_HOLD_MILLISECONDS,
  REMINDER_DISPATCH_LATE_AFTER_MILLISECONDS,
  REMINDER_DISPATCH_MAX_SAFE_ATTEMPTS,
  REMINDER_RECURRENCE_MAX_SKIPPED_OCCURRENCES,
} from "./reminder-config.js";
import type { ReminderRecurrenceUnit, ReminderScope } from "./reminder-record.js";

const DESTINATION_UNPROVEN = "AGENT_REMINDER_DESTINATION_UNPROVEN";

export interface ClaimedReminder {
  taskReminderKind?: 'execution' | 'response';
  content: string;
  delayed: boolean;
  dueAt: string;
  familyId: string;
  forumTopicId: string | null;
  groupId: string | null;
  id: string;
  leaseToken: string;
  messageThreadId: string | null;
  ownerUserId: string | null;
  scope: ReminderScope;
  telegramChatId: string;
  timezone: string;
}

interface ClaimOptions {
  leaseMilliseconds: number;
  limit: number;
  now: Date;
}

interface ClaimedRow {
  task_reminder_kind: 'execution' | 'response';
  content: string;
  delayed: boolean;
  due_at: Date;
  family_id: string;
  forum_topic_id: string | null;
  group_id: string | null;
  id: string;
  lease_token: string;
  message_thread_id: string | null;
  owner_user_id: string | null;
  scope: ReminderScope;
  telegram_chat_id: string;
  timezone: string;
}

interface RecurrenceRow {
  family_id: string;
  next_due_at: Date;
  next_index: number;
}

function requireClaimOptions(options: ClaimOptions): void {
  if (
    !(options.now instanceof Date) ||
    Number.isNaN(options.now.getTime()) ||
    !Number.isInteger(options.limit) ||
    options.limit < 1 ||
    !Number.isInteger(options.leaseMilliseconds) ||
    options.leaseMilliseconds < 1
  ) {
    throw new AppError(
      "AGENT_REMINDER_CLAIM_INVALID",
      "Диспетчер получил некорректные параметры напоминаний",
    );
  }
}

async function recordFailures(
  client: PoolClient,
  rows: readonly { family_id: string; id: string }[],
  errorCode: string,
): Promise<void> {
  for (const row of rows) {
    await client.query(
      `INSERT INTO audit_events (family_id, event_type, subject_id, metadata)
       VALUES ($1, 'reminder.delivery_failed', $2, jsonb_build_object('code', $3::text))`,
      [row.family_id, row.id, errorCode],
    );
  }
}

/**
 * Доказательство аудитории идёт последним перед самой отправкой, потому что привязка чата к
 * области меняется между заведением напоминания и его сроком. Недоказанный адресат не завершает
 * напоминание: подтверждение состава — обычный шаг Telegram, и терминальный отказ терял бы все
 * напоминания всякий раз, когда кто-то входит в группу. Строка ждёт и уходит с опозданием.
 */
async function holdUnprovenDestination(id: string, leaseToken: string): Promise<void> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const row = (await client.query<{
      author_user_id: string; family_id: string; group_id: string | null;
      owner_user_id: string | null; space_id: string | null;
    }>(
      `SELECT author_user_id, family_id, group_id, owner_user_id, space_id FROM reminders
        WHERE id = $1 AND status = 'leased' AND lease_token = $2`,
      [id, leaseToken],
    )).rows[0];
    if (!row) {
      await client.query("COMMIT");
      return;
    }
    const proven = await isSpaceDestinationProven(client, {
      familyId: row.family_id,
      groupId: row.group_id,
      spaceId: row.space_id,
      // Личный чат доказывает владельца, общая область — членство того, кто напоминание завёл.
      userId: row.group_id === null ? row.owner_user_id : row.author_user_id,
    });
    if (proven) {
      await client.query("COMMIT");
      return;
    }
    // Попытка возвращается: неподтверждённая аудитория не тратит бюджет безопасных повторов.
    const held = await client.query<{ repeated: boolean }>(
      `UPDATE reminders
          SET status = 'active', attempts = greatest(attempts - 1, 0),
              available_at = now() + ($3::text || ' milliseconds')::interval,
              lease_token = NULL, lease_expires_at = NULL, dispatch_started_at = NULL,
              last_error_code = $4, updated_at = now()
        WHERE id = $1 AND status = 'leased' AND lease_token = $2
        RETURNING (last_error_code IS NOT DISTINCT FROM $4::text) AS repeated`,
      [id, leaseToken, REMINDER_DESTINATION_HOLD_MILLISECONDS, DESTINATION_UNPROVEN],
    );
    if (held.rows[0] && !held.rows[0].repeated) {
      await client.query(
        `INSERT INTO audit_events (family_id, event_type, subject_id, metadata)
         VALUES ($1, 'reminder.destination_held', $2, jsonb_build_object('code', $3::text))`,
        [row.family_id, id, DESTINATION_UNPROVEN],
      );
    }
    await client.query("COMMIT");
    throw new AppError(DESTINATION_UNPROVEN, "Состав чата ещё не подтверждён, напоминание ждёт");
  } catch (error) {
    if (!isAppError(error) || error.code !== DESTINATION_UNPROVEN) await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export const reminderDispatchRepository = {
  async claimDue(options: ClaimOptions): Promise<ClaimedReminder[]> {
    requireClaimOptions(options);
    const client = await database().connect();
    try {
      await client.query("BEGIN");

      // Once Telegram dispatch starts, an expired lease is ambiguous and must never auto-repeat.
      const ambiguous = await client.query<{ family_id: string; id: string }>(
        `UPDATE reminders
         SET status = 'failed', lease_token = NULL, lease_expires_at = NULL,
             dispatch_started_at = NULL,
             last_error_code = 'AGENT_REMINDER_DELIVERY_AMBIGUOUS', updated_at = $1
         WHERE status = 'leased' AND lease_expires_at < $1 AND dispatch_started_at IS NOT NULL
         RETURNING id, family_id`,
        [options.now],
      );
      await recordFailures(client, ambiguous.rows, "AGENT_REMINDER_DELIVERY_AMBIGUOUS");

      // A crash before the side-effect marker is safe to recover, but retries remain explicitly bounded.
      const exhausted = await client.query<{ family_id: string; id: string }>(
        `UPDATE reminders
         SET status = 'failed', lease_token = NULL, lease_expires_at = NULL,
             last_error_code = 'AGENT_REMINDER_DELIVERY_ATTEMPTS_EXHAUSTED', updated_at = $1
         WHERE status = 'leased' AND lease_expires_at < $1 AND dispatch_started_at IS NULL
           AND attempts >= $2
         RETURNING id, family_id`,
        [options.now, REMINDER_DISPATCH_MAX_SAFE_ATTEMPTS],
      );
      await recordFailures(client, exhausted.rows, "AGENT_REMINDER_DELIVERY_ATTEMPTS_EXHAUSTED");
      await client.query(
        `UPDATE reminders
         SET status = 'active', lease_token = NULL, lease_expires_at = NULL, updated_at = $1
         WHERE status = 'leased' AND lease_expires_at < $1 AND dispatch_started_at IS NULL
           AND attempts < $2`,
        [options.now, REMINDER_DISPATCH_MAX_SAFE_ATTEMPTS],
      );

      // Removed memberships or changed trust zones invalidate a proactive destination fail-closed.
      const invalid = await client.query<{ family_id: string; id: string }>(
        `UPDATE reminders AS reminder
         SET status = 'failed', last_error_code = 'AGENT_REMINDER_DESTINATION_REVOKED',
             updated_at = $1
         WHERE reminder.status = 'active' AND (
            NOT EXISTS (
              SELECT 1 FROM family_memberships
              WHERE family_id = reminder.family_id AND user_id = reminder.author_user_id
            ) OR (
              reminder.scope = 'family' AND NOT EXISTS (
                SELECT 1 FROM telegram_groups AS group_row
                WHERE group_row.id = reminder.group_id AND group_row.family_id = reminder.family_id
                  AND group_row.telegram_chat_id = reminder.telegram_chat_id
                  AND group_row.type = 'family_private'
              )
            )
          )
         RETURNING reminder.id, reminder.family_id`,
        [options.now],
      );
      await recordFailures(client, invalid.rows, "AGENT_REMINDER_DESTINATION_REVOKED");

      await client.query(`UPDATE reminders r SET status='paused',updated_at=$1
        WHERE r.shared_task_id IS NOT NULL AND r.status='active'
        AND NOT (${linkedTaskActive('r')})`,[options.now]);

      // Quiet hours defer availability while retaining the original due_at for delayed-delivery notice.
      await client.query(
        `UPDATE reminders AS reminder
         SET available_at = (
               (($1 AT TIME ZONE settings.timezone)::date + settings.quiet_end) +
               make_interval(days => CASE
                 WHEN settings.quiet_start > settings.quiet_end
                   AND ($1 AT TIME ZONE settings.timezone)::time >= settings.quiet_start
                 THEN 1 ELSE 0 END)
             ) AT TIME ZONE settings.timezone,
             delayed_by_quiet_hours = true,
             updated_at = $1
         FROM user_notification_settings AS settings
         WHERE reminder.status = 'active' AND reminder.author_user_id = settings.user_id
           AND reminder.available_at <= $1
           AND ${quietHoursClause({ alias: "settings", now: "$1" })}`,
        [options.now],
      );

      const claimed = await client.query<ClaimedRow>(
        `WITH candidates AS (
           SELECT reminder.id
           FROM reminders AS reminder
           JOIN family_memberships AS membership
             ON membership.family_id = reminder.family_id AND membership.user_id = reminder.author_user_id
           WHERE reminder.status = 'active' AND reminder.available_at <= $1
             AND reminder.attempts < $4
             AND (reminder.shared_task_id IS NULL OR ${linkedTaskActive('reminder')})
           ORDER BY reminder.available_at, reminder.id
           FOR UPDATE OF reminder SKIP LOCKED
           LIMIT $2
         )
         UPDATE reminders AS reminder
         SET status = 'leased', attempts = attempts + 1, lease_token = gen_random_uuid(),
             lease_expires_at = $1 + ($3::text || ' milliseconds')::interval,
             dispatch_started_at = NULL, updated_at = $1
         FROM candidates
         WHERE reminder.id = candidates.id
         RETURNING reminder.id, reminder.family_id, reminder.owner_user_id, reminder.group_id,
                   reminder.content, reminder.task_reminder_kind, reminder.scope, reminder.timezone, reminder.telegram_chat_id,
                    reminder.message_thread_id::text, reminder.forum_topic_id::text,
                    reminder.due_at, reminder.lease_token::text,
                   (reminder.delayed_by_quiet_hours OR reminder.due_at < $1 - ($5::text || ' milliseconds')::interval) AS delayed`,
        [
          options.now,
          options.limit,
          options.leaseMilliseconds,
          REMINDER_DISPATCH_MAX_SAFE_ATTEMPTS,
          REMINDER_DISPATCH_LATE_AFTER_MILLISECONDS,
        ],
      );
      await client.query("COMMIT");
      return claimed.rows.map((row) => ({
        content: row.content,
        taskReminderKind: row.task_reminder_kind,
        delayed: row.delayed,
        dueAt: row.due_at.toISOString(),
        familyId: row.family_id,
        forumTopicId: row.forum_topic_id,
        groupId: row.group_id,
        id: row.id,
        leaseToken: row.lease_token,
        messageThreadId: row.message_thread_id,
        ownerUserId: row.owner_user_id,
        scope: row.scope,
        telegramChatId: row.telegram_chat_id,
        timezone: row.timezone,
      }));
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async markDispatchStarted(id: string, leaseToken: string): Promise<void> {
    await checkLinkedReminderBeforeDispatch(id,leaseToken);
    await holdUnprovenDestination(id, leaseToken);
    const result = await database().query(
      `UPDATE reminders SET dispatch_started_at = now(), updated_at = now()
       WHERE id = $1 AND status = 'leased' AND lease_token = $2
         AND dispatch_started_at IS NULL
         AND (shared_task_id IS NULL OR ${linkedTaskActive('reminders')})`,
      [id, leaseToken],
    );
    if (!result.rowCount) {
      throw new AppError(
        "AGENT_REMINDER_LEASE_STALE",
        "Доставка напоминания уже неактуальна",
      );
    }
  },

  async complete(
    job: ClaimedReminder,
    completedAt: Date,
    receipt: ProactiveDeliveryReceipt,
  ): Promise<void> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const reminder = await client.query<{
        family_id: string;
        recurrence_unit: ReminderRecurrenceUnit | null;
      }>(
        `SELECT family_id, recurrence_unit FROM reminders
         WHERE id = $1 AND status = 'leased' AND lease_token = $2
           AND dispatch_started_at IS NOT NULL
         FOR UPDATE`,
        [job.id, job.leaseToken],
      );
      const current = reminder.rows[0];
      if (!current) {
        // A retry after a lost COMMIT acknowledgement: this exact message is already recorded for
        // this occurrence, so completion happened and must not be reported as stale.
        const recorded = await client.query(
          `SELECT 1 FROM proactive_deliveries
            WHERE source_kind = 'reminder' AND source_id = $1 AND telegram_message_id = $2
              AND scheduled_for = $3 AND telegram_chat_id = $4`,
          [job.id, receipt.messageId, new Date(job.dueAt), job.telegramChatId],
        );
        if (recorded.rowCount === 1) {
          await client.query("COMMIT");
          return;
        }
        throw new AppError("AGENT_REMINDER_LEASE_STALE", "Доставка напоминания уже неактуальна");
      }

      // The journal row and reminder state commit together after Telegram confirms the message id.
      await recordProactiveDelivery(client, {
        content: receipt.text,
        deliveredAt: completedAt,
        familyId: job.familyId,
        groupId: job.groupId,
        messageThreadId: job.messageThreadId,
        ownerUserId: job.ownerUserId,
        scheduledFor: new Date(job.dueAt),
        scope: job.scope,
        sourceId: job.id,
        sourceKind: "reminder",
        telegramChatId: job.telegramChatId,
        telegramMessageId: receipt.messageId,
        title: null,
      });

      if (current.recurrence_unit === null) {
        await client.query(
          `UPDATE reminders
           SET status = 'completed', lease_token = NULL, lease_expires_at = NULL,
               dispatch_started_at = NULL, delayed_by_quiet_hours = false,
               last_error_code = NULL, updated_at = $2
           WHERE id = $1`,
          [job.id, completedAt],
        );
      } else {
        // Recompute from the original local anchor, skipping missed occurrences without replaying them.
        const recurrence = await client.query<RecurrenceRow>(
          `WITH RECURSIVE occurrences AS (
             SELECT reminder.family_id, reminder.occurrence_index + 1 AS next_index,
                    CASE reminder.recurrence_unit
                      WHEN 'daily' THEN (reminder.recurrence_anchor_local + make_interval(days => reminder.recurrence_interval * (reminder.occurrence_index + 1))) AT TIME ZONE reminder.timezone
                      WHEN 'weekly' THEN (reminder.recurrence_anchor_local + make_interval(days => 7 * reminder.recurrence_interval * (reminder.occurrence_index + 1))) AT TIME ZONE reminder.timezone
                      WHEN 'monthly' THEN (reminder.recurrence_anchor_local + make_interval(months => reminder.recurrence_interval * (reminder.occurrence_index + 1))) AT TIME ZONE reminder.timezone
                     END AS next_due_at,
                    reminder.occurrence_index AS initial_index
             FROM reminders AS reminder WHERE reminder.id = $1
             UNION ALL
             SELECT occurrence.family_id, occurrence.next_index + 1,
                    CASE reminder.recurrence_unit
                      WHEN 'daily' THEN (reminder.recurrence_anchor_local + make_interval(days => reminder.recurrence_interval * (occurrence.next_index + 1))) AT TIME ZONE reminder.timezone
                      WHEN 'weekly' THEN (reminder.recurrence_anchor_local + make_interval(days => 7 * reminder.recurrence_interval * (occurrence.next_index + 1))) AT TIME ZONE reminder.timezone
                      WHEN 'monthly' THEN (reminder.recurrence_anchor_local + make_interval(months => reminder.recurrence_interval * (occurrence.next_index + 1))) AT TIME ZONE reminder.timezone
                     END,
                    occurrence.initial_index
             FROM occurrences AS occurrence
             JOIN reminders AS reminder ON reminder.id = $1
             WHERE occurrence.next_due_at <= $2
               AND occurrence.next_index - occurrence.initial_index < $3
           )
           SELECT family_id, next_index, next_due_at
           FROM occurrences WHERE next_due_at > $2
           ORDER BY next_index LIMIT 1`,
          [job.id, completedAt, REMINDER_RECURRENCE_MAX_SKIPPED_OCCURRENCES],
        );
        const next = recurrence.rows[0];
        if (!next) {
          throw new AppError(
            "AGENT_REMINDER_RECURRENCE_EXHAUSTED",
            "Не удалось вычислить следующее время повторяющегося напоминания",
          );
        }
        await client.query(
          `UPDATE reminders
           SET status = CASE WHEN shared_task_id IS NOT NULL AND NOT (${linkedTaskActive('reminders')}) THEN 'paused'::reminder_status ELSE 'active'::reminder_status END, occurrence_index = $2, due_at = $3, available_at = $3,
               attempts = 0, lease_token = NULL, lease_expires_at = NULL,
               dispatch_started_at = NULL, delayed_by_quiet_hours = false,
               last_error_code = NULL, updated_at = $4
           WHERE id = $1`,
          [job.id, next.next_index, next.next_due_at, completedAt],
        );
      }
      await client.query(
        `INSERT INTO audit_events (family_id, event_type, subject_id, metadata)
         VALUES ($1, 'reminder.delivered', $2, jsonb_build_object('delayed', $3::boolean))`,
        [current.family_id, job.id, job.delayed],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async fail(job: ClaimedReminder, errorCode: string): Promise<void> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const failed = await client.query<{ family_id: string }>(
        `UPDATE reminders
         SET status = 'failed', lease_token = NULL, lease_expires_at = NULL,
             dispatch_started_at = NULL, last_error_code = $3, updated_at = now()
         WHERE id = $1 AND status = 'leased' AND lease_token = $2
         RETURNING family_id`,
        [job.id, job.leaseToken, errorCode],
      );
      if (!failed.rows[0]) {
        throw new AppError("AGENT_REMINDER_LEASE_STALE", "Ошибка доставки уже неактуальна");
      }
      await recordFailures(client, [{ family_id: failed.rows[0].family_id, id: job.id }], errorCode);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
};
