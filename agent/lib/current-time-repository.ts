/**
 * Current-time settings repository.
 *
 * Export:
 * - `currentTimeRepository`: reads an authenticated family user's optional IANA timezone, and the
 *   timezone a turn should speak in (the user's own, else the family owner's).
 */
import { database } from "./database.js";

export const currentTimeRepository = {
  async findUserTimezone(userId: string, familyId: string): Promise<string | null> {
    // Membership binding prevents a stale or cross-family identity from exposing settings.
    const result = await database().query<{ timezone: string }>(
      `SELECT settings.timezone
       FROM user_notification_settings AS settings
       JOIN family_memberships AS membership ON membership.user_id = settings.user_id
       WHERE settings.user_id = $1 AND membership.family_id = $2`,
      [userId, familyId],
    );
    return result.rows[0]?.timezone ?? null;
  },

  /**
   * The civil timezone of a turn: the sender's own setting when they are a family member with one,
   * else the family owner's, else null. Timeline stamps and the local time line share it, so a
   * stranger in an external group reads the chat in the family's home time rather than UTC.
   */
  async findTurnTimezone(userId: string | null, familyId: string): Promise<string | null> {
    const result = await database().query<{ timezone: string }>(
      `SELECT settings.timezone
       FROM family_memberships AS membership
       JOIN user_notification_settings AS settings ON settings.user_id = membership.user_id
       WHERE membership.family_id = $2
         AND (membership.user_id = $1 OR membership.role = 'owner')
       ORDER BY COALESCE(membership.user_id = $1, false) DESC
       LIMIT 1`,
      [userId, familyId],
    );
    return result.rows[0]?.timezone ?? null;
  },
};
