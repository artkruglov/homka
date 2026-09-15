/**
 * Shared PostgreSQL fixtures for group memory-review integration tests.
 *
 * Exports:
 * - `insertReviewUserMessage`: one passive user message on a group timeline.
 * - `insertReviewSession`: one canonical group session that can own a review turn.
 */
import { database } from "../database.js";

export async function insertReviewUserMessage(input: {
  conversationId: string;
  groupId: string | null;
  messageThreadId?: number;
  sequence: number;
}): Promise<{ id: string }> {
  return (await database().query<{ id: string }>(
    `INSERT INTO telegram_group_messages
       (conversation_id, group_id, telegram_message_id, sequence_id, actor_kind, actor_id,
        telegram_user_id, sender_display_name, sender_is_bot, message_kind, content_text,
        message_thread_id, sent_at)
     VALUES ($1, $2, $3, $3, 'user', 'telegram:agent-memory-author',
             'agent-memory-author', 'Анна', false, 'text', $4, $5, now())
     RETURNING id`,
    [input.conversationId, input.groupId, input.sequence,
      `Сообщение памяти ${input.sequence}`, input.messageThreadId ?? null],
  )).rows[0]!;
}

export async function insertReviewSession(
  familyId: string,
  groupId: string,
  conversationKey: string,
): Promise<string> {
  return (await database().query<{ id: string }>(
    `INSERT INTO conversation_sessions
       (thread_id, generation, family_id, group_id, scope, kind, conversation_key,
        continuation_token, started_at, last_activity_at)
     VALUES (gen_random_uuid(), 0, $1, $2, 'family', 'canonical', $3, $3, now(), now())
     RETURNING id`,
    [familyId, groupId, conversationKey],
  )).rows[0]!.id;
}
