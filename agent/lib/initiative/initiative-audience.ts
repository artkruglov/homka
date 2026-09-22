/**
 * Кому бот вообще может написать первым.
 *
 * Экспорт:
 * - `InitiativeRecipientRow`: строка выборки адресатов.
 * - `InitiativeRecipient`: человек, его правило инициативы и метка родства.
 * - `initiativeRecipientQuery`: запрос адресатов с дополнительным условием вызывающего.
 * - `toInitiativeRecipient`: разбор строки в правило и состояние.
 *
 * Условия одни и те же для утреннего обзора, коуча и уведомлений: у человека есть каноническая
 * личная сессия с ботом (строку `application_conversations` база заводит каждому участнику сама и
 * ничего не доказывает), а пояс и тихие часы берутся его собственные, иначе владельца семьи —
 * тот же порядок, что у штампов времени. Держать это в одном месте важнее краткости: разошедшиеся
 * копии однажды начнут писать разным людям в разное время.
 */
import type { InitiativeSettings, InitiativeState } from "./initiative-policy.js";

export const INITIATIVE_DEFAULT_DAILY_LIMIT = 3;

export interface InitiativeRecipientRow {
  coach_enabled: boolean | null;
  daily_limit: number;
  enabled: boolean;
  family_id: string;
  quiet_end: string | null;
  quiet_start: string | null;
  relation: "child" | "other" | "parent" | "partner" | null | undefined;
  sent_today: string;
  telegram_user_id: string;
  timezone: string;
  unanswered: string;
  user_id: string;
  weekly_review_enabled: boolean | null;
}

export interface InitiativeRecipient {
  readonly familyId: string;
  readonly userId: string;
  readonly telegramUserId: string;
  readonly settings: InitiativeSettings;
  readonly state: InitiativeState;
  readonly relation: InitiativeRecipientRow["relation"];
  readonly coachEnabled: boolean | null;
  readonly weeklyReviewEnabled: boolean | null;
}

/**
 * `$1` это момент времени, `$2` предел по умолчанию. `extraWhere` добавляет условие вызывающего,
 * например «коуч не выключен» или «недельный обзор включён».
 */
export function initiativeRecipientQuery(extraWhere = ""): string {
  const zone = "COALESCE(settings.timezone, owner_settings.timezone, 'UTC')";
  return `SELECT DISTINCT ON (membership.family_id, person.id)
              membership.family_id, person.id AS user_id, person.telegram_user_id,
              ${zone} AS timezone,
              to_char(settings.quiet_start, 'HH24:MI') AS quiet_start,
              to_char(settings.quiet_end, 'HH24:MI') AS quiet_end,
              COALESCE(settings.initiative_enabled, true) AS enabled,
              COALESCE(settings.initiative_daily_limit, $2::smallint) AS daily_limit,
              settings.coach_enabled, settings.weekly_review_enabled, membership.relation,
              (SELECT count(*) FROM initiative_messages AS sent
                WHERE sent.user_id = person.id
                  AND sent.sent_on = ($1::timestamptz AT TIME ZONE ${zone})::date
              )::text AS sent_today,
              (SELECT count(*) FROM initiative_messages AS sent
                WHERE sent.user_id = person.id AND sent.answered_at IS NULL)::text AS unanswered
         FROM family_memberships AS membership
         JOIN users AS person ON person.id = membership.user_id
         JOIN application_conversations AS chat ON chat.family_id = membership.family_id
          AND chat.owner_user_id = person.id AND chat.scope = 'personal'
          AND chat.telegram_group_id IS NULL AND chat.telegram_chat_id = person.telegram_user_id
         LEFT JOIN user_notification_settings AS settings ON settings.user_id = person.id
         LEFT JOIN family_memberships AS owner_membership
           ON owner_membership.family_id = membership.family_id AND owner_membership.role = 'owner'
         LEFT JOIN user_notification_settings AS owner_settings
           ON owner_settings.user_id = owner_membership.user_id
        WHERE person.telegram_user_id IS NOT NULL
          -- Написать первым Telegram даёт только тому, кто сам начал разговор с ботом.
          AND EXISTS (SELECT 1 FROM conversation_sessions AS session
                       WHERE session.family_id = membership.family_id AND session.scope = 'personal'
                         AND session.owner_user_id = person.id AND session.kind = 'canonical')
          ${extraWhere}
        ORDER BY membership.family_id, person.id`;
}

export function toInitiativeRecipient(row: InitiativeRecipientRow): InitiativeRecipient {
  return {
    coachEnabled: row.coach_enabled,
    familyId: row.family_id,
    relation: row.relation ?? null,
    settings: {
      dailyLimit: row.daily_limit,
      enabled: row.enabled,
      quietEnd: row.quiet_end,
      quietStart: row.quiet_start,
      timezone: row.timezone,
    },
    state: { sentToday: Number(row.sent_today), unanswered: Number(row.unanswered) },
    telegramUserId: row.telegram_user_id,
    userId: row.user_id,
    weeklyReviewEnabled: row.weekly_review_enabled,
  };
}
