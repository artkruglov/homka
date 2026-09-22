/**
 * Окна личного времени: чтение, добавление и снятие.
 *
 * Экспорт:
 * - `personalTimeRepository`: окна человека и проверка чужого срока по ним.
 *
 * Своё личное время человек ведёт только в личном чате: в общем оно стало бы объявлением, а
 * отказаться от вечера при всех труднее, чем поставить окно молча.
 */
import { AppError } from "../app-error.js";
import { database } from "../database.js";
import type { MemoryAuthorization } from "../memory-context.js";
import { personalTimeClause, type PersonalTimeWindow } from "./personal-time.js";

const MAX_WINDOWS_PER_PERSON = 20;

function requireOwnChat(auth: MemoryAuthorization): { familyId: string; userId: string } {
  if (auth.groupId !== null || auth.userId === null || auth.telegramUserId === null) {
    throw new AppError(
      "AGENT_PERSONAL_TIME_PRIVATE_ONLY",
      "Личное время настраивается только в личном чате",
    );
  }
  return { familyId: auth.familyId, userId: auth.userId };
}

export const personalTimeRepository = {
  async list(auth: MemoryAuthorization): Promise<(PersonalTimeWindow & { id: string })[]> {
    const { userId } = requireOwnChat(auth);
    const { rows } = await database().query<{
      ends_at: string; id: string; starts_at: string; title: string; weekday: number | null;
    }>(
      `SELECT id, title, weekday, to_char(starts_at,'HH24:MI') AS starts_at,
              to_char(ends_at,'HH24:MI') AS ends_at
         FROM personal_time_windows WHERE user_id = $1
        ORDER BY weekday NULLS FIRST, starts_at`,
      [userId],
    );
    return rows.map((row) => ({
      endsAt: row.ends_at, id: row.id, startsAt: row.starts_at, title: row.title,
      weekday: row.weekday,
    }));
  },

  async add(
    auth: MemoryAuthorization,
    input: { endsAt: string; startsAt: string; title: string; weekday: number | null },
  ): Promise<PersonalTimeWindow & { id: string }> {
    const { familyId, userId } = requireOwnChat(auth);
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const count = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM personal_time_windows WHERE user_id = $1", [userId],
      );
      if (Number(count.rows[0]!.count) >= MAX_WINDOWS_PER_PERSON) {
        throw new AppError(
          "AGENT_PERSONAL_TIME_LIMIT",
          "Окон личного времени уже достаточно много. Снимите ненужное, прежде чем добавлять новое",
        );
      }
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO personal_time_windows(family_id,user_id,title,weekday,starts_at,ends_at)
         VALUES($1,$2,$3,$4,$5::time,$6::time)
         ON CONFLICT (user_id, weekday, starts_at, ends_at) DO NOTHING RETURNING id`,
        [familyId, userId, input.title, input.weekday, input.startsAt, input.endsAt],
      );
      await client.query("COMMIT");
      if (!inserted.rows[0]) {
        throw new AppError("AGENT_PERSONAL_TIME_DUPLICATE", "Такое окно личного времени уже есть");
      }
      return { ...input, id: inserted.rows[0].id };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async remove(auth: MemoryAuthorization, id: string): Promise<boolean> {
    const { userId } = requireOwnChat(auth);
    const removed = await database().query(
      "DELETE FROM personal_time_windows WHERE id = $1 AND user_id = $2", [id, userId],
    );
    return (removed.rowCount ?? 0) > 0;
  },

  /**
   * Название окна, в которое попадает срок, либо `null`. Читается по Telegram-идентификатору
   * человека внутри его семьи, а пояс берётся из его настроек. Название годится для решения и для
   * собственного окна человека; чужому участнику оно не показывается — довольно самой занятости.
   */
  async conflictFor(telegramUserId: string, familyId: string, at: Date): Promise<string | null> {
    const { rows } = await database().query<{ title: string }>(
      // `window` в PostgreSQL зарезервировано: псевдоним не может так называться.
      `SELECT slot.title FROM personal_time_windows AS slot
         JOIN users AS person ON person.id = slot.user_id
         LEFT JOIN user_notification_settings AS settings ON settings.user_id = person.id
        WHERE person.telegram_user_id = $2 AND slot.family_id = $3
          AND ${personalTimeClause({ alias: "slot", at: "$1", timezone: "settings.timezone" })}
        LIMIT 1`,
      [at, telegramUserId, familyId],
    );
    return rows[0]?.title ?? null;
  },
};
