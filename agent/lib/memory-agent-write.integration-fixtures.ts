/**
 * Main-agent memory write integration fixtures.
 *
 * Exports:
 * - `createMainAgentMemoryFixture`: verified family conversation, author, source, and authorization.
 * - `createMainAgentPrivateMemoryFixture`: verified private conversation and personal source.
 */
import { database } from "./database.js";
import type { MemoryAuthorization } from "./memory-context.js";

export async function createMainAgentMemoryFixture() {
  const family = await database().query<{ id: string }>(
    "INSERT INTO families (name) VALUES ('Main agent memory') RETURNING id",
  );
  const user = await database().query<{ id: string }>(
    "INSERT INTO users (telegram_user_id, display_name) VALUES ('agent-memory-author', 'Анна') RETURNING id",
  );
  await database().query(
    "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')",
    [family.rows[0]!.id, user.rows[0]!.id],
  );
  const group = await database().query<{ id: string }>(
    `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode)
     VALUES ($1, '-100-agent-memory', 'Семья', 'family_private', 'addressed_only') RETURNING id`,
    [family.rows[0]!.id],
  );
  const conversation = await database().query<{ id: string }>(
    "SELECT id FROM application_conversations WHERE telegram_group_id = $1",
    [group.rows[0]!.id],
  );
  await database().query(
    `INSERT INTO conversation_participants
       (conversation_id, family_id, scope, scope_partition_key, telegram_user_id,
        linked_user_id, display_name_snapshot, first_observed_at, last_observed_at)
     VALUES ($1, $2, 'family', $2, 'agent-memory-author', $3, 'Анна', now(), now())`,
    [conversation.rows[0]!.id, family.rows[0]!.id, user.rows[0]!.id],
  );
  const message = await database().query<{ id: string }>(
    `INSERT INTO telegram_group_messages
       (conversation_id, group_id, telegram_message_id, sequence_id, actor_kind, actor_id,
        telegram_user_id, sender_display_name, sender_is_bot, message_kind, content_text, sent_at)
     VALUES ($1, $2, 901, 1, 'user', 'telegram:agent-memory-author', 'agent-memory-author',
             'Анна', false, 'text', 'Я начинаю готовиться к марафону', now()) RETURNING id`,
    [conversation.rows[0]!.id, group.rows[0]!.id],
  );
  const auth: MemoryAuthorization = {
    familyId: family.rows[0]!.id,
    groupId: group.rows[0]!.id,
    role: "owner",
    scopes: ["family"],
    telegramActorId: "agent-memory-author",
    telegramActorKind: "telegram_user",
    telegramUserId: "agent-memory-author",
    userId: user.rows[0]!.id,
  };
  return {
    auth,
    conversationId: conversation.rows[0]!.id,
    familyId: family.rows[0]!.id,
    groupId: group.rows[0]!.id,
    timelineEntryId: message.rows[0]!.id,
    userId: user.rows[0]!.id,
  };
}

export async function createMainAgentPrivateMemoryFixture() {
  const family = await database().query<{ id: string }>(
    "INSERT INTO families (name) VALUES ('Private agent memory') RETURNING id",
  );
  const user = await database().query<{ id: string }>(
    "INSERT INTO users (telegram_user_id, display_name) VALUES ('private-memory-author', 'Анна') RETURNING id",
  );
  await database().query(
    "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')",
    [family.rows[0]!.id, user.rows[0]!.id],
  );
  const conversation = await database().query<{ id: string }>(
    "SELECT id FROM application_conversations WHERE owner_user_id = $1",
    [user.rows[0]!.id],
  );
  await database().query(
    `INSERT INTO conversation_participants
       (conversation_id, family_id, scope, scope_partition_key, telegram_user_id,
        linked_user_id, display_name_snapshot, first_observed_at, last_observed_at)
     VALUES ($1, $2, 'personal', $3, 'private-memory-author', $3, 'Анна', now(), now())`,
    [conversation.rows[0]!.id, family.rows[0]!.id, user.rows[0]!.id],
  );
  const message = await database().query<{ id: string }>(
    `INSERT INTO telegram_group_messages
       (conversation_id, telegram_message_id, sequence_id, actor_kind, actor_id,
        telegram_user_id, sender_display_name, sender_is_bot, message_kind, content_text, sent_at)
     VALUES ($1, 903, 1, 'user', 'telegram:private-memory-author', 'private-memory-author',
             'Анна', false, 'text', 'Я начинаю готовиться к марафону', now()) RETURNING id`,
    [conversation.rows[0]!.id],
  );
  const auth: MemoryAuthorization = {
    familyId: family.rows[0]!.id,
    groupId: null,
    role: "owner",
    scopes: ["personal", "family"],
    telegramActorId: "private-memory-author",
    telegramActorKind: "telegram_user",
    telegramUserId: "private-memory-author",
    userId: user.rows[0]!.id,
  };
  return {
    auth,
    conversationId: conversation.rows[0]!.id,
    timelineEntryId: message.rows[0]!.id,
    userId: user.rows[0]!.id,
  };
}
