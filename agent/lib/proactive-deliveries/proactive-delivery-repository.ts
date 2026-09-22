/**
 * PostgreSQL proactive delivery journal.
 *
 * Exports:
 * - `ProactiveDeliveryAuthorization`: exact personal or family trust-zone selector.
 * - `ProactiveDeliveryInput`: successful Telegram delivery persistence contract.
 * - `ProactiveDeliveryReceipt`: Telegram message identity and delivered text.
 * - `recordProactiveDelivery`: transaction-composable insertion helper.
 * - `proactiveDeliveryRepository`: context cursor, history search, and standalone recording.
 */
import type { Pool, PoolClient } from "pg";

import {
  PROACTIVE_DELIVERY_CONTEXT_MAX_AGE_DAYS,
  PROACTIVE_DELIVERY_CONTEXT_MAX_CHARACTERS,
  PROACTIVE_DELIVERY_CONTEXT_MAX_ITEMS,
  PROACTIVE_DELIVERY_HISTORY_MAX_LIMIT,
} from "../../config.js";
import { AppError } from "../app-error.js";
import { database } from "../database.js";
import type { SpaceAttributes } from "../spaces/space-attributes.js";
import {
  decodeDateBigintCursor,
  encodeDateBigintCursor,
  paginationFilterDigest,
} from "../keyset-pagination.js";
import {
  formatProactiveDeliveryContext,
  type ProactiveDeliveryRecord,
  type ProactiveDeliverySourceKind,
} from "./proactive-delivery-context.js";

export interface ProactiveDeliveryAuthorization {
  /** Область хода. Её отсутствие после включения режима отсекает общая граница инструментов. */
  space?: SpaceAttributes;
  familyId: string;
  groupId: string | null;
  messageThreadId: string | null;
  ownerUserId: string | null;
  scope: "family" | "group" | "personal";
  telegramChatId: string;
}

export interface ProactiveDeliveryInput extends ProactiveDeliveryAuthorization {
  content: string;
  deliveredAt: Date;
  scheduledFor: Date;
  sourceId: string;
  sourceKind: ProactiveDeliverySourceKind;
  telegramMessageId: string;
  title: string | null;
}

export interface ProactiveDeliveryReceipt {
  messageId: string;
  text: string;
}

interface DeliveryRow {
  content_text: string;
  delivered_at: Date;
  id: string;
  scheduled_for: Date;
  source_id: string;
  source_kind: ProactiveDeliverySourceKind;
  title: string | null;
}

type QueryClient = Pool | PoolClient;

function requirePositiveBigint(value: string, field: string): string {
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new AppError(
      "AGENT_PROACTIVE_DELIVERY_INVALID",
      `Не удалось сохранить доставку: поле ${field} должно быть положительным идентификатором`,
    );
  }
  return value;
}

function requireAuthorization(input: ProactiveDeliveryAuthorization): void {
  const validPersonal = input.scope === "personal" && input.ownerUserId !== null &&
    input.groupId === null && input.messageThreadId === null;
  const validFamily = input.scope === "family" && input.ownerUserId === null &&
    input.groupId !== null;
  const validGroup = input.scope === "group" && input.ownerUserId === null &&
    input.groupId !== null && input.messageThreadId === null;
  if (!validPersonal && !validFamily && !validGroup) {
    throw new AppError(
      "AGENT_PROACTIVE_DELIVERY_SCOPE_INVALID",
      "Не удалось определить область истории уведомлений",
    );
  }
}

function requireDelivery(input: ProactiveDeliveryInput): void {
  requireAuthorization(input);
  requirePositiveBigint(input.telegramMessageId, "telegramMessageId");
  if (
    !input.content.trim() ||
    !(input.deliveredAt instanceof Date) ||
    Number.isNaN(input.deliveredAt.getTime()) ||
    !(input.scheduledFor instanceof Date) ||
    Number.isNaN(input.scheduledFor.getTime())
  ) {
    throw new AppError(
      "AGENT_PROACTIVE_DELIVERY_INVALID",
      "Не удалось сохранить доставку: отсутствует текст или корректное время",
    );
  }
}

function mapRows(rows: readonly DeliveryRow[]): ProactiveDeliveryRecord[] {
  return rows.map((row) => ({
    content: row.content_text,
    deliveredAt: row.delivered_at.toISOString(),
    deliveryId: row.id,
    scheduledFor: row.scheduled_for.toISOString(),
    sourceId: row.source_id,
    sourceKind: row.source_kind,
    title: row.title,
  }));
}

export async function recordProactiveDelivery(
  client: QueryClient,
  input: ProactiveDeliveryInput,
): Promise<void> {
  requireDelivery(input);
  // Область доставка наследует от своего источника, а не от вызывающего: ход, заведший
  // напоминание, к этому моменту давно закончился, а перечислять места вставки значит однажды
  // забыть одно из них. Источник полиморфен, поэтому наследование живёт здесь, а не в триггере.
  await client.query(
    `INSERT INTO proactive_deliveries
       (family_id, owner_user_id, group_id, scope, source_kind, source_id, title,
        content_text, scheduled_for, delivered_at, telegram_chat_id,
        message_thread_id, telegram_message_id, space_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
             CASE $5::proactive_delivery_source_kind
               WHEN 'reminder' THEN (SELECT space_id FROM reminders WHERE id = $6::uuid)
               WHEN 'agent_schedule' THEN (
                 SELECT schedule.space_id FROM agent_schedules AS schedule
                   JOIN agent_schedule_runs AS run ON run.schedule_id = schedule.id
                  WHERE run.id = $6::uuid)
               -- Бот начал личный разговор сам: вопрос живёт в личном пространстве адресата.
               WHEN 'daily_overview' THEN (SELECT id FROM spaces WHERE family_id = $1
                 AND kind = 'personal' AND owner_user_id = $2 AND state = 'active'
                 ORDER BY created_at LIMIT 1)
               WHEN 'coach' THEN (SELECT id FROM spaces WHERE family_id = $1
                 AND kind = 'personal' AND owner_user_id = $2 AND state = 'active'
                 ORDER BY created_at LIMIT 1)
             END)
     ON CONFLICT (source_kind, source_id, telegram_message_id) DO NOTHING`,
    [
      input.familyId,
      input.ownerUserId,
      input.groupId,
      input.scope,
      input.sourceKind,
      input.sourceId,
      input.title,
      input.content.trim(),
      input.scheduledFor,
      input.deliveredAt,
      input.telegramChatId,
      input.messageThreadId,
      input.telegramMessageId,
    ],
  );
}

export const proactiveDeliveryRepository = {
  async record(input: ProactiveDeliveryInput): Promise<void> {
    await recordProactiveDelivery(database(), input);
  },

  async listPendingContext(
    input: ProactiveDeliveryAuthorization & { applicationSessionId: string; now: Date },
  ): Promise<{ context: string; cursor: string } | null> {
    requireAuthorization(input);
    if (!(input.now instanceof Date) || Number.isNaN(input.now.getTime())) {
      throw new AppError(
        "AGENT_PROACTIVE_CONTEXT_TIME_INVALID",
        "Не удалось определить время для истории уведомлений",
      );
    }

    // The application session must itself own the requested trust zone before any journal read.
    const session = await database().query<{
      last_proactive_delivery_id: string;
      space_id: string | null;
      space_policy_version: number | null;
    }>(
      `SELECT last_proactive_delivery_id::text, space_id, space_policy_version
         FROM conversation_sessions
        WHERE id = $1 AND retired_at IS NULL AND family_id = $2 AND scope = $3
          AND owner_user_id IS NOT DISTINCT FROM $4::uuid
          AND group_id IS NOT DISTINCT FROM $5::uuid`,
      [input.applicationSessionId, input.familyId, input.scope, input.ownerUserId, input.groupId],
    );
    const cursor = session.rows[0]?.last_proactive_delivery_id;
    // Бэкфилл переноса проставил область всей прежней истории, поэтому привязанной считается
    // только сессия с версией политики: без этой оговорки прежний режим отфильтровал бы сам себя.
    const spaceId = session.rows[0]?.space_policy_version === null
      ? null
      : session.rows[0]?.space_id ?? null;
    if (cursor === undefined) {
      throw new AppError(
        "AGENT_PROACTIVE_CONTEXT_SESSION_INVALID",
        "Текущий разговор не соответствует области истории уведомлений",
      );
    }

    // Select newest unseen rows first for a hard bound, then restore delivery chronology.
    const result = await database().query<DeliveryRow>(
      `SELECT * FROM (
         SELECT id::text, source_id::text, source_kind, title, content_text, scheduled_for, delivered_at
           FROM proactive_deliveries
          WHERE id > $1::bigint AND family_id = $2 AND scope = $3
            AND owner_user_id IS NOT DISTINCT FROM $4::uuid
            AND group_id IS NOT DISTINCT FROM $5::uuid
            AND telegram_chat_id = $6
            AND message_thread_id IS NOT DISTINCT FROM $7::bigint
            AND delivered_at <= $8
            AND delivered_at >= $8 - ($9::text || ' days')::interval
            AND ($11::uuid IS NULL OR space_id = $11::uuid)
          ORDER BY id DESC
          LIMIT $10
       ) AS recent ORDER BY id::bigint ASC`,
      [
        cursor,
        input.familyId,
        input.scope,
        input.ownerUserId,
        input.groupId,
        input.telegramChatId,
        input.messageThreadId,
        input.now,
        PROACTIVE_DELIVERY_CONTEXT_MAX_AGE_DAYS,
        PROACTIVE_DELIVERY_CONTEXT_MAX_ITEMS,
        spaceId,
      ],
    );
    const records = mapRows(result.rows);
    if (records.length === 0) return null;
    const context = formatProactiveDeliveryContext(
      records,
      PROACTIVE_DELIVERY_CONTEXT_MAX_CHARACTERS,
    );
    if (!context) return null;
    return { context, cursor: records.at(-1)!.deliveryId };
  },

  async advanceSessionCursor(applicationSessionId: string, cursor: string): Promise<void> {
    requirePositiveBigint(cursor, "cursor");
    const result = await database().query(
      `UPDATE conversation_sessions
          SET last_proactive_delivery_id = greatest(last_proactive_delivery_id, $2::bigint)
        WHERE id = $1 AND retired_at IS NULL`,
      [applicationSessionId, cursor],
    );
    if (result.rowCount !== 1) {
      throw new AppError(
        "AGENT_PROACTIVE_CONTEXT_SESSION_INVALID",
        "Не удалось подтвердить историю уведомлений для текущего разговора",
      );
    }
  },

  async list(
    input: ProactiveDeliveryAuthorization & {
      cursor?: string;
      deliveredAfter: Date | null;
      deliveredBefore: Date | null;
      limit: number;
      query: string | null;
      sourceKind: ProactiveDeliverySourceKind | null;
    },
  ): Promise<{ items: ProactiveDeliveryRecord[]; nextCursor: string | null }> {
    requireAuthorization(input);
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > PROACTIVE_DELIVERY_HISTORY_MAX_LIMIT) {
      throw new AppError(
        "AGENT_PROACTIVE_DELIVERY_LIMIT_INVALID",
        "Некорректный размер страницы истории уведомлений",
      );
    }
    for (const date of [input.deliveredAfter, input.deliveredBefore]) {
      if (date !== null && (!(date instanceof Date) || Number.isNaN(date.getTime()))) {
        throw new AppError(
          "AGENT_PROACTIVE_DELIVERY_DATE_INVALID",
          "Период истории уведомлений содержит некорректную дату",
        );
      }
    }
    if (input.deliveredAfter && input.deliveredBefore && input.deliveredAfter > input.deliveredBefore) {
      throw new AppError(
        "AGENT_PROACTIVE_DELIVERY_DATE_RANGE_INVALID",
        "Начало периода истории уведомлений не может быть позже его окончания",
      );
    }
    const cursorBinding = paginationFilterDigest([
      "proactive-delivery-v1",
      // Область входит в отпечаток курсора: страница, выданная в одной области, не продолжается
      // в другой, даже если чат и период совпали.
      input.space?.spaceId ?? null,
      input.familyId,
      input.scope,
      input.ownerUserId,
      input.groupId,
      input.telegramChatId,
      input.messageThreadId,
      input.sourceKind,
      input.query,
      input.deliveredAfter?.toISOString() ?? null,
      input.deliveredBefore?.toISOString() ?? null,
    ]);
    const cursor = decodeDateBigintCursor(
      input.cursor,
      "AGENT_PROACTIVE_DELIVERY_CURSOR_INVALID",
      "Не удалось продолжить просмотр истории уведомлений",
      cursorBinding,
    );
    const result = await database().query<DeliveryRow>(
      `SELECT id::text, source_id::text, source_kind, title, content_text, scheduled_for, delivered_at
         FROM proactive_deliveries
        WHERE family_id = $1 AND scope = $2
          AND owner_user_id IS NOT DISTINCT FROM $3::uuid
          AND group_id IS NOT DISTINCT FROM $4::uuid
          AND telegram_chat_id = $5
          AND message_thread_id IS NOT DISTINCT FROM $6::bigint
           AND ($7::proactive_delivery_source_kind IS NULL OR source_kind = $7)
           AND ($8::text IS NULL OR search_vector @@ websearch_to_tsquery('russian', $8))
           AND ($9::timestamptz IS NULL OR delivered_at >= $9)
           AND ($10::timestamptz IS NULL OR delivered_at <= $10)
           AND ($14::uuid IS NULL OR space_id = $14::uuid)
           AND ($11::timestamptz IS NULL OR (delivered_at, id) < ($11, $12::bigint))
         ORDER BY delivered_at DESC, id DESC
         LIMIT $13`,
      [
        input.familyId,
        input.scope,
        input.ownerUserId,
        input.groupId,
        input.telegramChatId,
        input.messageThreadId,
        input.sourceKind,
        input.query,
        input.deliveredAfter,
        input.deliveredBefore,
        cursor?.timestamp ?? null,
        cursor?.id ?? null,
        input.limit + 1,
        input.space?.spaceId ?? null,
      ],
    );
    const hasNext = result.rows.length > input.limit;
    const rows = result.rows.slice(0, input.limit);
    const last = rows.at(-1);
    return {
      items: mapRows(rows),
      nextCursor: hasNext && last
        ? encodeDateBigintCursor(last.delivered_at, last.id, cursorBinding)
        : null,
    };
  },
};
