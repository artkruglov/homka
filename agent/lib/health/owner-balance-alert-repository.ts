/**
 * Send claims for the low-balance alert, one per family per UTC day.
 *
 * Export:
 * - `ownerBalanceAlertRepository`: claim before the Telegram send, complete, release or abandon.
 *
 * Mirrors `owner_health_digests`: a claim older than an hour without a send belongs to a dispatcher
 * that died mid-way and is taken again; an unclear delivery keeps its code and is never retried.
 */
import { database } from "../database.js";

export const ownerBalanceAlertRepository = {
  async claim(familyId: string, alertDate: string, now: Date): Promise<boolean> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `DELETE FROM owner_balance_alerts
          WHERE family_id = $1 AND alert_date = $2 AND sent_at IS NULL AND diagnostic_code IS NULL
            AND claimed_at < $3::timestamptz - interval '1 hour'`,
        [familyId, alertDate, now],
      );
      const inserted = await client.query(
        `INSERT INTO owner_balance_alerts (family_id, alert_date, claimed_at)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING family_id`,
        [familyId, alertDate, now],
      );
      await client.query("COMMIT");
      return inserted.rows.length === 1;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async complete(familyId: string, alertDate: string, now: Date): Promise<void> {
    await database().query(
      "UPDATE owner_balance_alerts SET sent_at = $3 WHERE family_id = $1 AND alert_date = $2",
      [familyId, alertDate, now],
    );
  },

  async release(familyId: string, alertDate: string): Promise<void> {
    await database().query(
      `DELETE FROM owner_balance_alerts
        WHERE family_id = $1 AND alert_date = $2 AND sent_at IS NULL AND diagnostic_code IS NULL`,
      [familyId, alertDate],
    );
  },

  async abandon(familyId: string, alertDate: string, diagnosticCode: string): Promise<void> {
    await database().query(
      `UPDATE owner_balance_alerts SET diagnostic_code = $3
        WHERE family_id = $1 AND alert_date = $2 AND sent_at IS NULL`,
      [familyId, alertDate, diagnosticCode],
    );
  },
};
