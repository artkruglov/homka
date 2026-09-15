/**
 * Cached Telegram reaction policy of one chat.
 *
 * Export:
 * - `telegramReactionPolicyRepository`: verified read and upsert of the per-chat reaction set.
 */
import { database } from "./database.js";
import type { TelegramReactionPolicy } from "./telegram-reaction-policy.js";

export const telegramReactionPolicyRepository = {
  async read(
    telegramChatId: string,
  ): Promise<(TelegramReactionPolicy & { fetchedAt: Date }) | null> {
    const result = await database().query<{
      allows_all: boolean;
      emoji: string[];
      fetched_at: Date;
    }>(
      `SELECT allows_all, emoji, fetched_at FROM telegram_chat_reaction_policies
       WHERE telegram_chat_id = $1`,
      [telegramChatId],
    );
    const row = result.rows[0];
    return row === undefined
      ? null
      : { allowsAll: row.allows_all, emoji: row.emoji, fetchedAt: row.fetched_at };
  },

  async save(telegramChatId: string, policy: TelegramReactionPolicy): Promise<void> {
    await database().query(
      `INSERT INTO telegram_chat_reaction_policies (telegram_chat_id, allows_all, emoji, fetched_at)
       VALUES ($1, $2, $3::text[], now())
       ON CONFLICT (telegram_chat_id) DO UPDATE
         SET allows_all = $2, emoji = $3::text[], fetched_at = now()`,
      [telegramChatId, policy.allowsAll, policy.allowsAll ? [] : [...policy.emoji]],
    );
  },
};
