/**
 * Данные коуча: кому можно написать, что о человеке известно и заявка на касание.
 *
 * Экспорт:
 * - `CoachRecipient`: человек с личным чатом, его правило инициативы и факты для повода.
 * - `coachRepository`: адресаты, заявка на сутки, её возврат.
 *
 * Факты это только структура: окна личного времени, традиции, предложения партнёра и прошлые
 * касания. Текст переписки, память и дела коуч не читает. Пишет только тем, кто сам писал боту
 * в личку: Telegram не даёт боту начать разговор первым, а общий чат для вопроса о себе не место.
 */
import { database } from "../database.js";
import type { CoachFacts, CoachReason, CoachTouch } from "./coach.js";
import type { InitiativeSettings, InitiativeState } from "./initiative-policy.js";

const DEFAULT_DAILY_LIMIT = 3;
const QUIET_RITUAL_DAYS = 14;

export interface CoachRecipient {
  readonly familyId: string;
  readonly userId: string;
  readonly telegramUserId: string;
  readonly settings: InitiativeSettings;
  readonly state: InitiativeState;
  readonly facts: CoachFacts;
}

interface RecipientRow {
  coach_enabled: boolean | null;
  daily_limit: number;
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

async function factsFor(row: RecipientRow, now: Date): Promise<CoachFacts> {
  const db = database();
  const params = [row.family_id, row.user_id, row.telegram_user_id, now, QUIET_RITUAL_DAYS];
  const [touches, decision, ritual, windows, rituals] = await Promise.all([
    db.query<{ coach_reason: CoachReason; last_at: Date; week: string }>(
      `SELECT coach_reason, max(sent_at) AS last_at,
              count(*) FILTER (WHERE sent_at > $2::timestamptz - interval '7 days')::text AS week
         FROM initiative_messages WHERE user_id = $1 AND kind = 'coach'
        GROUP BY coach_reason`,
      [row.user_id, now],
    ),
    db.query<{ id: string; title: string; proposer: string }>(
      `SELECT decision.id, decision.title, proposer.display_name AS proposer
         FROM joint_decisions AS decision
         JOIN users AS proposer ON proposer.id = decision.creator_user_id
        WHERE decision.family_id = $1 AND decision.partner_user_id = $2 AND NOT decision.cancelled
          AND NOT EXISTS (SELECT 1 FROM joint_decision_answers AS answer
                           WHERE answer.decision_id = decision.id AND answer.actor_user_id = $2)
          AND NOT EXISTS (SELECT 1 FROM initiative_messages AS touch
                           WHERE touch.user_id = $2 AND touch.kind = 'coach'
                             AND touch.coach_subject = decision.id)
        ORDER BY decision.created_at LIMIT 1`,
      params.slice(0, 2),
    ),
    db.query<{ id: string; title: string }>(
      `SELECT task.id, task.title FROM shared_tasks AS task
        WHERE task.family_id = $1 AND task.kind = 'ritual' AND task.scope IN ('personal', 'family')
          AND task.status IN ('open', 'accepted')
          AND (task.assignee_telegram_id = $3 OR task.creator_telegram_id = $3)
          AND task.created_at < $4::timestamptz - make_interval(days => $5)
          AND NOT EXISTS (SELECT 1 FROM shared_ritual_occurrences AS occurrence
                           WHERE occurrence.task_id = task.id
                             AND occurrence.occurred_on > ($4::timestamptz - make_interval(days => $5))::date)
          AND NOT EXISTS (SELECT 1 FROM initiative_messages AS touch
                           WHERE touch.user_id = $2 AND touch.kind = 'coach' AND touch.coach_subject = task.id
                             AND touch.sent_at > $4::timestamptz - make_interval(days => $5))
        ORDER BY task.created_at LIMIT 1`,
      params,
    ),
    db.query<{ count: string }>(
      "SELECT count(*)::text FROM personal_time_windows WHERE family_id = $1 AND user_id = $2",
      params.slice(0, 2),
    ),
    db.query<{ count: string }>(
      `SELECT count(*)::text FROM shared_tasks
        WHERE family_id = $1 AND kind = 'ritual' AND status IN ('open', 'proposed', 'accepted')
          AND (scope = 'family' OR (scope = 'personal' AND assignee_telegram_id = $2))`,
      [row.family_id, row.telegram_user_id],
    ),
  ]);
  const lastByReason: Partial<Record<CoachReason, Date>> = {};
  let lastTouchAt: Date | null = null;
  let touchesLastWeek = 0;
  for (const touch of touches.rows) {
    lastByReason[touch.coach_reason] = touch.last_at;
    if (lastTouchAt === null || touch.last_at > lastTouchAt) lastTouchAt = touch.last_at;
    touchesLastWeek += Number(touch.week);
  }
  return {
    enabled: row.coach_enabled,
    familyRituals: Number(rituals.rows[0]?.count ?? 0),
    invited: lastByReason.invite !== undefined,
    lastByReason,
    lastTouchAt,
    openDecision: decision.rows[0] ?? null,
    personalWindows: Number(windows.rows[0]?.count ?? 0),
    quietRitual: ritual.rows[0] ?? null,
    touchesLastWeek,
  };
}

export const coachRepository = {
  /** Люди с подтверждённым личным чатом; выключенный коуч отсекается сразу, без чтения фактов. */
  async recipients(now: Date): Promise<CoachRecipient[]> {
    const { rows } = await database().query<RecipientRow>(
      `SELECT DISTINCT ON (membership.family_id, person.id)
              membership.family_id, person.id AS user_id, person.telegram_user_id,
              COALESCE(settings.timezone, 'UTC') AS timezone,
              to_char(settings.quiet_start, 'HH24:MI') AS quiet_start,
              to_char(settings.quiet_end, 'HH24:MI') AS quiet_end,
              COALESCE(settings.initiative_enabled, true) AS enabled,
              COALESCE(settings.initiative_daily_limit, $2::smallint) AS daily_limit,
              settings.coach_enabled,
              (SELECT count(*) FROM initiative_messages AS sent
                WHERE sent.user_id = person.id
                  AND sent.sent_on = ($1::timestamptz AT TIME ZONE COALESCE(settings.timezone, 'UTC'))::date
              )::text AS sent_today,
              (SELECT count(*) FROM initiative_messages AS sent
                WHERE sent.user_id = person.id AND sent.answered_at IS NULL)::text AS unanswered
         FROM family_memberships AS membership
         JOIN users AS person ON person.id = membership.user_id
         JOIN application_conversations AS chat ON chat.family_id = membership.family_id
          AND chat.owner_user_id = person.id AND chat.scope = 'personal'
          AND chat.telegram_group_id IS NULL AND chat.telegram_chat_id = person.telegram_user_id
         LEFT JOIN user_notification_settings AS settings ON settings.user_id = person.id
        WHERE person.telegram_user_id IS NOT NULL
          AND settings.coach_enabled IS DISTINCT FROM false
          -- Строку личного чата база заводит каждому участнику сама; написать первым Telegram даёт
          -- только тому, кто сам начал разговор, а его след это личная сессия с ботом.
          AND EXISTS (SELECT 1 FROM conversation_sessions AS session
                       WHERE session.family_id = membership.family_id AND session.scope = 'personal'
                         AND session.owner_user_id = person.id AND session.kind = 'canonical')
        ORDER BY membership.family_id, person.id`,
      [now, DEFAULT_DAILY_LIMIT],
    );
    const recipients: CoachRecipient[] = [];
    for (const row of rows) {
      recipients.push({
        facts: await factsFor(row, now),
        familyId: row.family_id,
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
      });
    }
    return recipients;
  },

  /** Заявка до отправки: одно касание в сутки человека держит уникальный индекс. */
  async claim(recipient: CoachRecipient, localDate: string, touch: CoachTouch, now: Date): Promise<string | null> {
    const inserted = await database().query<{ delivery_ref: string }>(
      `INSERT INTO initiative_messages(family_id, user_id, kind, sent_on, sent_at, coach_reason, coach_subject)
       VALUES ($1, $2, 'coach', $3::date, $4, $5, $6::uuid)
       ON CONFLICT DO NOTHING RETURNING delivery_ref`,
      [recipient.familyId, recipient.userId, localDate, now, touch.reason, touch.subject],
    );
    return inserted.rows[0]?.delivery_ref ?? null;
  },

  async release(deliveryRef: string): Promise<void> {
    await database().query("DELETE FROM initiative_messages WHERE delivery_ref = $1 AND kind = 'coach'", [deliveryRef]);
  },
};
