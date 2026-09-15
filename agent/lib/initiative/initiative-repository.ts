/**
 * Журнал начатых ботом разговоров и настройки человека к ним.
 *
 * Экспорт:
 * - `initiativeRepository`: состояние для правила, запись начатого разговора, снятие паузы.
 *
 * Сутки считаются в поясе человека, а не сервера: предел «три раза в день» это его день.
 * Неотвеченным считается всё, что стоит после его последнего слова, поэтому его сообщение
 * обнуляет счёт одним оператором, а не разбором истории.
 */
import type { PoolClient } from "pg";

import { database } from "../database.js";
import type { InitiativeKind, InitiativeSettings, InitiativeState } from "./initiative-policy.js";

const DEFAULT_DAILY_LIMIT = 3;

interface SettingsRow {
  daily_limit: number;
  enabled: boolean;
  quiet_end: string | null;
  quiet_start: string | null;
  sent_today: string;
  timezone: string;
  unanswered: string;
}

export const initiativeRepository = {
  /** Настройки и уже случившееся одним запросом: правило считается на снимке одного момента. */
  async read(
    userId: string,
    now: Date,
    client?: PoolClient,
  ): Promise<{ settings: InitiativeSettings; state: InitiativeState } | null> {
    const executor = client ?? database();
    const { rows } = await executor.query<SettingsRow>(
      `WITH person AS (
         SELECT person.id,
                COALESCE(settings.timezone, 'UTC') AS timezone,
                to_char(settings.quiet_start, 'HH24:MI') AS quiet_start,
                to_char(settings.quiet_end, 'HH24:MI') AS quiet_end,
                COALESCE(settings.initiative_enabled, true) AS enabled,
                COALESCE(settings.initiative_daily_limit, $3::smallint) AS daily_limit
           FROM users AS person
           LEFT JOIN user_notification_settings AS settings ON settings.user_id = person.id
          WHERE person.id = $1
       )
       SELECT person.timezone, person.quiet_start, person.quiet_end, person.enabled,
              person.daily_limit,
              (SELECT count(*) FROM initiative_messages AS sent
                WHERE sent.user_id = person.id
                  AND sent.sent_on = ($2::timestamptz AT TIME ZONE person.timezone)::date
              )::text AS sent_today,
              (SELECT count(*) FROM initiative_messages AS sent
                WHERE sent.user_id = person.id AND sent.answered_at IS NULL)::text AS unanswered
         FROM person`,
      [userId, now, DEFAULT_DAILY_LIMIT],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      settings: {
        dailyLimit: row.daily_limit,
        enabled: row.enabled,
        quietEnd: row.quiet_end,
        quietStart: row.quiet_start,
        timezone: row.timezone,
      },
      state: { sentToday: Number(row.sent_today), unanswered: Number(row.unanswered) },
    };
  },

  async record(input: {
    familyId: string;
    kind: InitiativeKind;
    now: Date;
    userId: string;
  }): Promise<void> {
    await database().query(
      `INSERT INTO initiative_messages(family_id, user_id, kind, sent_on, sent_at)
       SELECT $1, $2, $3,
              ($4::timestamptz AT TIME ZONE COALESCE(settings.timezone, 'UTC'))::date, $4
         FROM users AS person
         LEFT JOIN user_notification_settings AS settings ON settings.user_id = person.id
        WHERE person.id = $2`,
      [input.familyId, input.userId, input.kind, input.now],
    );
  },

  /**
   * То же по Telegram-идентификатору: нажатая кнопка это ответ, а у обработчика callback есть
   * только он. Без этого три «позже» подряд выглядели бы как молчание и закрывали бы предложения.
   */
  async markAnsweredByTelegramId(telegramUserId: string, now: Date): Promise<void> {
    await database().query(
      `UPDATE initiative_messages SET answered_at = $2
        WHERE answered_at IS NULL AND sent_at <= $2
          AND user_id = (SELECT id FROM users WHERE telegram_user_id = $1)`,
      [telegramUserId, now],
    );
  },

  /** Человек написал сам: пауза снимается целиком, потому что она и была про его молчание. */
  async markAnswered(userId: string, now: Date): Promise<void> {
    await database().query(
      `UPDATE initiative_messages SET answered_at = $2
        WHERE user_id = $1 AND answered_at IS NULL AND sent_at <= $2`,
      [userId, now],
    );
  },
};
