/**
 * Shared fixtures for memory-thread repository integration tests.
 *
 * Exports:
 * - `ThreadRepositoryFixture`: trusted IDs and authorization for one family thread scenario.
 * - `THREAD_TITLE_VECTOR`: deterministic title embedding used by activation tests.
 * - `createThreadRepositoryFixture`: creates one evidenced family claim and Telegram source.
 * - `createBroadThread`: materializes a persisted broad root-thread fixture.
 * - `createAdditionalProjectClaim`: uses the current writer to attach a second sourced claim.
 */
import { database } from "./database.js";
import { MEMORY_EMBEDDING_MODEL_VERSION } from "./memory-config.js";
import type { MemoryAuthorization } from "./memory-context.js";
import { memoryRepository } from "./memory-repository.js";
import { memoryThreadQueryRepository } from "./memory-thread-query-repository.js";

export interface ThreadRepositoryFixture {
  auth: MemoryAuthorization;
  claimId: string;
  conversationId: string;
  familyId: string;
  groupId: string;
  projectTitle: string;
  userId: string;
}

export const THREAD_TITLE_VECTOR = [1, ...Array.from({ length: 383 }, () => 0)];

export async function createThreadRepositoryFixture(): Promise<ThreadRepositoryFixture> {
  const family = await database().query<{ id: string }>(
    "INSERT INTO families (name) VALUES ('Thread repositories') RETURNING id",
  );
  const user = await database().query<{ id: string }>(
    "INSERT INTO users (telegram_user_id, display_name) VALUES ('thread-owner', 'Owner') RETURNING id",
  );
  await database().query(
    "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')",
    [family.rows[0]!.id, user.rows[0]!.id],
  );
  const group = await database().query<{ id: string }>(
    `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode)
     VALUES ($1, '-100-thread-repository', 'Family', 'family_private', 'addressed_only') RETURNING id`,
    [family.rows[0]!.id],
  );
  const conversation = await database().query<{ id: string }>(
    "SELECT id FROM application_conversations WHERE telegram_group_id = $1",
    [group.rows[0]!.id],
  );
  const participant = await database().query<{ id: string }>(
    `INSERT INTO conversation_participants
       (conversation_id, family_id, scope, scope_partition_key, telegram_user_id,
        linked_user_id, display_name_snapshot, first_observed_at, last_observed_at)
     VALUES ($1, $2, 'family', $2, 'thread-owner', $3, 'Owner', now(), now()) RETURNING id`,
    [conversation.rows[0]!.id, family.rows[0]!.id, user.rows[0]!.id],
  );
  const timeline = await database().query<{ id: string }>(
    `INSERT INTO telegram_group_messages
       (group_id, conversation_id, telegram_message_id, sequence_id, actor_kind, actor_id,
        telegram_user_id, sender_display_name, sender_is_bot, message_kind, content_text, sent_at)
     VALUES ($1, $2, 701, 1, 'user', 'telegram:thread-owner', 'thread-owner', 'Owner',
             false, 'text', 'Будем продолжать ремонт и фиксировать решения', now()) RETURNING id`,
    [group.rows[0]!.id, conversation.rows[0]!.id],
  );
  const claim = await database().query<{ id: string }>(
    `INSERT INTO memory_items
       (family_id, author_user_id, scope, kind, content, source, confirmation, sensitivity,
        operation_key, provenance_state, origin_conversation_id, subject_label, save_approved,
        content_normalized, profile_eligible)
     VALUES ($1, $2, 'family', 'episode', 'Ремонт будет продолжаться поэтапно', 'extraction',
             'model_high', 'normal', 'thread-repository-claim', 'evidenced', $3, 'квартира',
             true, 'ремонт будет продолжаться поэтапно', false) RETURNING id`,
    [family.rows[0]!.id, user.rows[0]!.id, conversation.rows[0]!.id],
  );
  await database().query(
    `INSERT INTO claim_evidence
       (claim_id, family_id, scope, scope_partition_key, evidence_role, evidence_kind,
        origin_conversation_id, origin_conversation_label_snapshot, origin_telegram_group_id,
        author_participant_id, author_user_id, author_label_snapshot, observed_at,
        evidence_snippet, timeline_entry_id, timeline_sequence, source_message_id, source_snapshot)
     VALUES ($1, $2, 'family', $2, 'primary', 'reported', $3, 'Family', $4, $5, $6,
             'Анна', now(), 'Будем продолжать ремонт и фиксировать решения', $7, 1, 701,
             '{"content":"Будем продолжать ремонт и фиксировать решения"}'::jsonb)`,
    [claim.rows[0]!.id, family.rows[0]!.id, conversation.rows[0]!.id, group.rows[0]!.id,
      participant.rows[0]!.id, user.rows[0]!.id, timeline.rows[0]!.id],
  );
  return {
    auth: {
      familyId: family.rows[0]!.id,
      groupId: null,
      role: "owner",
      scopes: ["family"],
      telegramActorId: "thread-owner",
      telegramActorKind: "telegram_user",
      telegramUserId: "thread-owner",
      userId: user.rows[0]!.id,
    },
    claimId: claim.rows[0]!.id,
    conversationId: conversation.rows[0]!.id,
    familyId: family.rows[0]!.id,
    groupId: group.rows[0]!.id,
    projectTitle: "Ремонт",
    userId: user.rows[0]!.id,
  };
}

export async function createBroadThread(fixture: ThreadRepositoryFixture) {
  // Repository/lifecycle tests need stable persisted state, not the retired discovery pipeline.
  const project = await database().query<{ id: string }>(
    `INSERT INTO memory_projects (family_id, scope, scope_partition_key, title)
     VALUES ($1, 'family', $1, $2) RETURNING id`,
    [fixture.familyId, fixture.projectTitle],
  );
  await database().query(
    "UPDATE memory_items SET memory_project_id = $2 WHERE id = $1",
    [fixture.claimId, project.rows[0]!.id],
  );
  const thread = await database().query<{ id: string }>(
    `INSERT INTO memory_threads
       (family_id, scope, scope_partition_key, memory_project_id, title, purpose,
        title_embedding, title_embedding_model)
     VALUES ($1, 'family', $1, $2, $3, 'Сохранять цели, решения и результаты ремонта',
             $4::vector, $5) RETURNING id`,
    [fixture.familyId, project.rows[0]!.id, fixture.projectTitle,
      `[${THREAD_TITLE_VECTOR.join(",")}]`, MEMORY_EMBEDDING_MODEL_VERSION],
  );
  await database().query(
    `INSERT INTO memory_thread_entries
       (thread_id, family_id, scope, scope_partition_key, source_claim_id, role, occurred_at)
     SELECT $1, family_id, scope, scope_partition_key, id, 'goal', created_at
     FROM memory_items WHERE id = $2`,
    [thread.rows[0]!.id, fixture.claimId],
  );
  await database().query(
    `INSERT INTO memory_thread_creation_notices
       (thread_id, family_id, status, origin_conversation_id, delivery_started_at,
        delivery_diagnostic_code)
     VALUES ($1, $2, 'failed', $3, now(), 'AGENT_MEMORY_THREAD_NOTICE_PRIVATE_ONLY')`,
    [thread.rows[0]!.id, fixture.familyId, fixture.conversationId],
  );
  return await memoryThreadQueryRepository.list(fixture.auth, { limit: 20 });
}

export async function createAdditionalProjectClaim(
  fixture: ThreadRepositoryFixture,
  threadRef: string,
): Promise<string> {
  const origin = await database().query<{ group_id: string; participant_id: string }>(
    `SELECT conversation.telegram_group_id AS group_id, participant.id AS participant_id
     FROM application_conversations AS conversation
     JOIN conversation_participants AS participant ON participant.conversation_id = conversation.id
     WHERE conversation.id = $1 AND participant.telegram_user_id = 'thread-owner'`,
    [fixture.conversationId],
  );
  const timeline = await database().query<{ id: string }>(
    `INSERT INTO telegram_group_messages
       (conversation_id, group_id, telegram_message_id, sequence_id, actor_kind, actor_id,
        telegram_user_id, sender_display_name, sender_is_bot, message_kind, content_text, sent_at)
     VALUES ($1, $2, 704, 2, 'user', 'telegram:thread-owner', 'thread-owner', 'Owner', false,
             'text', 'По ремонту выбрали поэтапный метод', now()) RETURNING id`,
    [fixture.conversationId, origin.rows[0]!.group_id],
  );
  const claim = await memoryRepository.create(fixture.auth, {
    confirmation: "model_high",
    content: "Ремонт выполняется поэтапно",
    explicitSource: {
      conversationId: fixture.conversationId,
      subject: { kind: "none" },
      timelineEntryId: timeline.rows[0]!.id,
    },
    kind: "fact",
    operationKey: "thread-repository-second",
    scope: "family",
    sensitivity: "normal",
    source: "test:main-agent",
    thread: { action: "attach", role: "method", threadRef },
  });
  return claim.id;
}
