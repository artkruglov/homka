/**
 * Данные утреннего обзора: кому, что и один раз в сутки.
 *
 * Экспорт:
 * - `dailyOverviewRepository`: адресаты, содержание дня, заявка на сутки и её возврат.
 *
 * Содержание собирается тем же планировщиком, что отвечает человеку в чате, и с той же
 * авторизацией: область берётся из его выбора, а дела — по его личности. Второго пути к делам
 * здесь нет, поэтому обзор не может показать больше, чем человек увидел бы сам.
 */
import type { PoolClient } from "pg";

import { database } from "../database.js";
import type { MemoryAuthorization } from "../memory-context.js";
import { sharedTaskRepository } from "../shared-task-repository.js";
import { readActiveSpace } from "../spaces/active-space.js";
import { readFamilySpaceMode } from "../spaces/family-space-mode.js";
import type { BoardTask } from "../task-board.js";
import type { DailyOverview } from "./daily-overview.js";
import type { DailyOverviewRecipient } from "./daily-overview-dispatch.js";

const DEFAULT_DAILY_LIMIT = 3;

interface RecipientRow {
  daily_limit: number;
  first_ever: boolean;
  enabled: boolean;
  family_id: string;
  quiet_end: string | null;
  quiet_start: string | null;
  sent_today: string;
  telegram_user_id: string;
  timezone: string;
  unanswered: string;
  user_id: string;
}

/** Область человека для фонового чтения: его собственный выбор, иначе личное пространство. */
async function overviewSpace(
  client: PoolClient, familyId: string, userId: string,
): Promise<{ policyVersion: number; spaceId: string } | null> {
  const chosen = await readActiveSpace(client, familyId, userId);
  const space = (await client.query<{ id: string; policy_version: number }>(
    `SELECT space.id, space.policy_version FROM spaces AS space
       JOIN space_memberships AS member ON member.space_id = space.id
        AND member.family_id = space.family_id AND member.user_id = $2 AND member.state = 'active'
      WHERE space.family_id = $1 AND space.state = 'active' AND space.kind <> 'group'
        AND ($3::uuid IS NULL OR space.id = $3::uuid)
      ORDER BY space.kind = 'personal' DESC, space.created_at
      LIMIT 1`,
    [familyId, userId, chosen],
  )).rows[0];
  return space ? { policyVersion: space.policy_version, spaceId: space.id } : null;
}

export const dailyOverviewRepository = {
  /** Все, у кого есть личный чат: обзор дня это личное сообщение, а не общий текст в группу. */
  async recipients(now: Date): Promise<DailyOverviewRecipient[]> {
    const { rows } = await database().query<RecipientRow>(
      `SELECT membership.family_id, person.id AS user_id, person.telegram_user_id,
              COALESCE(settings.timezone, 'UTC') AS timezone,
              to_char(settings.quiet_start, 'HH24:MI') AS quiet_start,
              to_char(settings.quiet_end, 'HH24:MI') AS quiet_end,
              COALESCE(settings.initiative_enabled, true) AS enabled,
              COALESCE(settings.initiative_daily_limit, $2::smallint) AS daily_limit,
              (SELECT count(*) FROM initiative_messages AS sent
                WHERE sent.user_id = person.id
                  AND sent.sent_on = ($1::timestamptz AT TIME ZONE COALESCE(settings.timezone, 'UTC'))::date
              )::text AS sent_today,
              (SELECT count(*) FROM initiative_messages AS sent
                WHERE sent.user_id = person.id AND sent.answered_at IS NULL)::text AS unanswered,
              NOT EXISTS (SELECT 1 FROM initiative_messages AS sent
                WHERE sent.user_id = person.id AND sent.kind = 'suggestion') AS first_ever
         FROM family_memberships AS membership
         JOIN users AS person ON person.id = membership.user_id
         LEFT JOIN user_notification_settings AS settings ON settings.user_id = person.id
        WHERE person.telegram_user_id IS NOT NULL
        ORDER BY membership.family_id, person.id`,
      [now, DEFAULT_DAILY_LIMIT],
    );
    return rows.map((row) => ({
      familyId: row.family_id,
      firstEver: row.first_ever,
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
    }));
  },

  async overview(recipient: DailyOverviewRecipient): Promise<DailyOverview> {
    const client = await database().connect();
    let space: { policyVersion: number; spaceId: string } | null;
    try {
      // Пока семья в прежнем режиме, пространство не подставляется: оно отсекло бы все дела без
      // привязки к нему. 22 сентября 2026 так пропали три просроченных дела из двадцати семи.
      space = await readFamilySpaceMode(client, recipient.familyId) === "spaces"
        ? await overviewSpace(client, recipient.familyId, recipient.userId)
        : null;
    } finally {
      client.release();
    }
    const auth: MemoryAuthorization = {
      familyId: recipient.familyId,
      groupId: null,
      role: "member",
      scopes: ["personal", "family"],
      ...(space === null ? {} : { space }),
      telegramActorId: recipient.telegramUserId,
      telegramActorKind: "telegram_user",
      telegramUserId: recipient.telegramUserId,
      userId: recipient.userId,
    };
    const tasks: BoardTask[] = [];
    let cursor: string | undefined;
    // Страница это сто дел; доска всё равно сокращает каждый список, поэтому трёх страниц хватит.
    for (let page = 0; page < 3; page += 1) {
      const result = await sharedTaskRepository.execute(auth,
        { action: "list", ...(cursor ? { cursor } : {}) }, "overview");
      tasks.push(...(result.tasks ?? []));
      cursor = result.nextCursor ?? undefined;
      if (!cursor) break;
    }
    const waiting = await sharedTaskRepository.execute(auth, { action: "list", view: "waiting", status: "proposed" }, "overview");
    return { now: new Date(), tasks, timezone: recipient.settings.timezone, waiting: waiting.tasks ?? [] };
  },

  /** Заявка на сутки: повтор невозможен по уникальному индексу, а не по проверке в коде. */
  async claim(recipient: DailyOverviewRecipient, localDate: string): Promise<string | null> {
    const inserted = await database().query<{ delivery_ref: string }>(
      `INSERT INTO initiative_messages(family_id, user_id, kind, sent_on)
       VALUES ($1, $2, 'suggestion', $3::date)
       ON CONFLICT DO NOTHING RETURNING delivery_ref`,
      [recipient.familyId, recipient.userId, localDate],
    );
    return inserted.rows[0]?.delivery_ref ?? null;
  },

  async release(recipient: DailyOverviewRecipient, localDate: string): Promise<void> {
    await database().query(
      `DELETE FROM initiative_messages
        WHERE user_id = $1 AND kind = 'suggestion' AND sent_on = $2::date`,
      [recipient.userId, localDate],
    );
  },
};
