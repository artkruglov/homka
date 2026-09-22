/**
 * Данные коуча: кому можно написать, что о человеке известно и заявка на касание.
 *
 * Экспорт:
 * - `CoachRecipient`: человек с личным чатом, его правило инициативы и факты для повода.
 * - `coachRepository`: адресаты и заявка на сутки.
 *
 * Факты это только структура: окна личного времени, традиции, предложения партнёра и прошлые
 * касания. Текст переписки, память и дела коуч не читает. Пишет только тем, кто сам писал боту
 * в личку: Telegram не даёт боту начать разговор первым, а общий чат для вопроса о себе не место.
 */
import { database } from "../database.js";
import type { CoachFacts, CoachReason, CoachTouch } from "./coach.js";
import {
  INITIATIVE_DEFAULT_DAILY_LIMIT,
  initiativeRecipientQuery,
  toInitiativeRecipient,
  type InitiativeRecipient,
  type InitiativeRecipientRow,
} from "./initiative-audience.js";

const QUIET_RITUAL_DAYS = 14;

export interface CoachRecipient extends InitiativeRecipient {
  readonly facts: CoachFacts;
}

async function factsFor(row: InitiativeRecipientRow, now: Date): Promise<CoachFacts> {
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
    relation: row.relation ?? null,
    familyRituals: Number(rituals.rows[0]?.count ?? 0),
    invited: lastByReason.invite !== undefined,
    lastByReason,
    lastTouchAt,
    openDecision: decision.rows[0] ?? null,
    personalWindows: Number(windows.rows[0]?.count ?? 0),
    quietRitual: ritual.rows[0] ?? null,
    touchesLastWeek,
    weeklyReviewEnabled: row.weekly_review_enabled === true,
  };
}

export const coachRepository = {
  /** Люди с личной сессией; выключенный коуч отсекается сразу, без чтения фактов. */
  async recipients(now: Date): Promise<CoachRecipient[]> {
    const { rows } = await database().query<InitiativeRecipientRow>(
      initiativeRecipientQuery("AND settings.coach_enabled IS DISTINCT FROM false"),
      [now, INITIATIVE_DEFAULT_DAILY_LIMIT],
    );
    const recipients: CoachRecipient[] = [];
    for (const row of rows) {
      const recipient = toInitiativeRecipient(row);
      recipients.push({ ...recipient, facts: await factsFor(row, now) });
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

};
