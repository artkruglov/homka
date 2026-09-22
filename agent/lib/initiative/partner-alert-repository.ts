/**
 * Данные уведомлений: кому можно написать и что именно ждёт его ответа.
 *
 * Экспорт:
 * - `PartnerAlertRecipient`: человек с личной сессией и его правило инициативы.
 * - `partnerAlertRepository`: адресаты, ожидающие пункты, заявка на сутки и отметка повтора.
 *
 * Читается только структура: чьё поручение, чья передача, чья область и чьё решение. Текст
 * переписки, память и содержание дел сюда не попадают. Пункт, о котором уже писали, возвращается
 * ровно один раз через неделю: напоминать третий раз значит давить.
 */
import { database } from "../database.js";
import {
  INITIATIVE_DEFAULT_DAILY_LIMIT,
  initiativeRecipientQuery,
  toInitiativeRecipient,
  type InitiativeRecipient,
  type InitiativeRecipientRow,
} from "./initiative-audience.js";
import { PARTNER_ALERT_MAX_ITEMS, type PartnerAlertItem, type PartnerAlertKind } from "./partner-alert.js";

export type PartnerAlertRecipient = InitiativeRecipient;

/** Через столько ожидание напоминает о себе во второй и последний раз. */
export const PARTNER_ALERT_REPEAT_DAYS = 7;

interface PendingRow {
  alert_kind: PartnerAlertKind;
  from_name: string;
  repeated: boolean;
  subject_id: string;
  title: string;
}

/**
 * Четыре источника ожидания одним запросом: иначе их порядок зависел бы от кода, а не от того,
 * что раньше попросили. Уже показанный пункт возвращается только через неделю и только однажды.
 */
const PENDING_SQL = `
WITH claimed AS (
  SELECT alert_kind, subject_id, claimed_at, reminded_at
    FROM partner_alert_claims WHERE user_id = $1
), waiting AS (
  SELECT 'task_proposed' AS alert_kind, task.id AS subject_id, task.title,
         author.display_name AS from_name, task.created_at AS since
    FROM shared_tasks AS task
    JOIN users AS author ON author.telegram_user_id = task.creator_telegram_id
   WHERE task.family_id = $2 AND task.status = 'proposed'
     AND task.assignee_telegram_id = $3 AND task.creator_telegram_id <> $3
  UNION ALL
  SELECT 'task_transfer', task.id, task.title, holder.display_name, task.transfer_requested_at
    FROM shared_tasks AS task
    JOIN users AS holder ON holder.telegram_user_id = task.assignee_telegram_id
   WHERE task.family_id = $2 AND task.pending_assignee_telegram_id = $3
  UNION ALL
  SELECT 'care_area_proposed', area.id, area.title,
         COALESCE(owner.display_name, creator.display_name), area.proposed_at
    FROM care_areas AS area
    LEFT JOIN users AS owner ON owner.telegram_user_id = area.owner_telegram_id
    JOIN users AS creator ON creator.telegram_user_id = area.creator_telegram_id
   WHERE area.family_id = $2 AND area.status = 'proposed'
     AND area.pending_owner_telegram_id = $3
  UNION ALL
  SELECT 'decision_open', decision.id, decision.title, proposer.display_name, decision.created_at
    FROM joint_decisions AS decision
    JOIN users AS proposer ON proposer.id = decision.creator_user_id
   WHERE decision.family_id = $2 AND decision.partner_user_id = $1 AND NOT decision.cancelled
     AND NOT EXISTS (SELECT 1 FROM joint_decision_answers AS answer
                      WHERE answer.decision_id = decision.id AND answer.actor_user_id = $1)
)
SELECT waiting.alert_kind, waiting.subject_id::text, waiting.title, waiting.from_name,
       (claimed.subject_id IS NOT NULL) AS repeated
  FROM waiting
  LEFT JOIN claimed ON claimed.alert_kind = waiting.alert_kind
                   AND claimed.subject_id = waiting.subject_id
 WHERE claimed.subject_id IS NULL
    OR (claimed.reminded_at IS NULL
        AND claimed.claimed_at < $4::timestamptz - make_interval(days => $5))
 ORDER BY waiting.since NULLS LAST`;

export const partnerAlertRepository = {
  /** Адресованное человеку дело не зависит от согласия на коуча: это не вопрос о жизни. */
  async recipients(now: Date): Promise<PartnerAlertRecipient[]> {
    const { rows } = await database().query<InitiativeRecipientRow>(
      initiativeRecipientQuery(),
      [now, INITIATIVE_DEFAULT_DAILY_LIMIT],
    );
    return rows.map(toInitiativeRecipient);
  },

  /** Ожидающие пункты человека: первые пять и число остальных. */
  async pending(
    recipient: PartnerAlertRecipient,
    now: Date,
  ): Promise<{ items: PartnerAlertItem[]; pending: number }> {
    const { rows } = await database().query<PendingRow>(PENDING_SQL, [
      recipient.userId, recipient.familyId, recipient.telegramUserId, now, PARTNER_ALERT_REPEAT_DAYS,
    ]);
    return {
      items: rows.slice(0, PARTNER_ALERT_MAX_ITEMS).map((row) => ({
        from: row.from_name,
        kind: row.alert_kind,
        repeated: row.repeated,
        subjectId: row.subject_id,
        title: row.title,
      })),
      pending: Math.max(0, rows.length - PARTNER_ALERT_MAX_ITEMS),
    };
  },

  /**
   * Заявка на сутки человека и отметки по каждому показанному пункту одной транзакцией: иначе
   * отправленное уведомление могло бы прийти о том же самом ещё раз.
   */
  async claim(
    recipient: PartnerAlertRecipient,
    localDate: string,
    items: readonly PartnerAlertItem[],
    now: Date,
  ): Promise<string | null> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query<{ delivery_ref: string }>(
        `INSERT INTO initiative_messages(family_id, user_id, kind, sent_on, sent_at)
         VALUES ($1, $2, 'partner_alert', $3::date, $4)
         ON CONFLICT DO NOTHING RETURNING delivery_ref`,
        [recipient.familyId, recipient.userId, localDate, now],
      );
      const deliveryRef = inserted.rows[0]?.delivery_ref ?? null;
      if (deliveryRef === null) {
        await client.query("ROLLBACK");
        return null;
      }
      for (const item of items) {
        await client.query(
          `INSERT INTO partner_alert_claims(family_id, user_id, alert_kind, subject_id, delivery_ref, claimed_at)
           VALUES ($1, $2, $3, $4::uuid, $5::uuid, $6)
           ON CONFLICT (user_id, alert_kind, subject_id) DO UPDATE SET reminded_at = $6`,
          [recipient.familyId, recipient.userId, item.kind, item.subjectId, deliveryRef, now],
        );
      }
      await client.query("COMMIT");
      return deliveryRef;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
};
