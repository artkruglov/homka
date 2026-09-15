/**
 * Completion-source mutation integration tests.
 *
 * Constructs covered:
 * - Explicit correction uses current-turn evidence and transfers active thread membership.
 * - Editing or deleting a completion source retracts its outcome and reactivates the thread.
 * - Physical claim deletion removes completion entries instead of failing on provenance FKs.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";
import type { MemoryAuthorization } from "./memory-context.js";
import { memoryRepository } from "./memory-repository.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;

interface CompletionFixture {
  auth: MemoryAuthorization;
  memoryRef: string;
  outcomeId: string;
  source: { conversationId: string; timelineEntryId: string };
  threadId: string;
}

async function createCompletionFixture(): Promise<CompletionFixture> {
  const family = await database().query<{ id: string }>(
    "INSERT INTO families (name) VALUES ('Completion invalidation') RETURNING id",
  );
  const user = await database().query<{ id: string }>(
    `INSERT INTO users (telegram_user_id, display_name)
     VALUES ('completion-owner', 'Owner') RETURNING id`,
  );
  await database().query(
    "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')",
    [family.rows[0]!.id, user.rows[0]!.id],
  );
  const group = await database().query<{ id: string }>(
    `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode)
     VALUES ($1, '-100-completion-invalidation', 'Family', 'family_private', 'addressed_only')
     RETURNING id`,
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
     VALUES ($1, $2, 'family', $2, 'completion-owner', $3, 'Owner', now(), now()) RETURNING id`,
    [conversation.rows[0]!.id, family.rows[0]!.id, user.rows[0]!.id],
  );
  const timeline = await database().query<{ id: string }>(
    `INSERT INTO telegram_group_messages
       (conversation_id, group_id, telegram_message_id, sequence_id, actor_kind, actor_id,
        telegram_user_id, sender_display_name, sender_is_bot, message_kind, content_text, sent_at)
     VALUES ($1, $2, 991, 1, 'user', 'telegram:completion-owner', 'completion-owner',
             'Owner', false, 'text', 'Работа завершена по исходному плану', now()) RETURNING id`,
    [conversation.rows[0]!.id, group.rows[0]!.id],
  );
  const correctionTimeline = await database().query<{ id: string }>(
    `INSERT INTO telegram_group_messages
       (conversation_id, group_id, telegram_message_id, sequence_id, actor_kind, actor_id,
        telegram_user_id, sender_display_name, sender_is_bot, message_kind, content_text, sent_at)
     VALUES ($1, $2, 992, 2, 'user', 'telegram:completion-owner', 'completion-owner',
             'Owner', false, 'text', 'Исправь память: работа ещё продолжается', now()) RETURNING id`,
    [conversation.rows[0]!.id, group.rows[0]!.id],
  );
  const project = await database().query<{ id: string }>(
    `INSERT INTO memory_projects (family_id, scope, scope_partition_key, title)
     VALUES ($1, 'family', $1, 'Проект завершения') RETURNING id`,
    [family.rows[0]!.id],
  );
  const claim = await database().query<{ id: string }>(
    `INSERT INTO memory_items
       (family_id, author_user_id, scope, kind, content, source, confirmation, sensitivity,
        operation_key, provenance_state, origin_conversation_id, memory_project_id,
        save_approved, content_normalized, profile_eligible)
     VALUES ($1, $2, 'family', 'episode', 'Исходный план завершён', 'test:completion',
             'user_confirmed', 'normal', 'completion-source-claim', 'evidenced', $3, $4,
             true, 'исходный план завершён', false) RETURNING id`,
    [family.rows[0]!.id, user.rows[0]!.id, conversation.rows[0]!.id, project.rows[0]!.id],
  );
  await database().query(
    `INSERT INTO claim_evidence
       (claim_id, family_id, scope, scope_partition_key, evidence_role, evidence_kind,
        origin_conversation_id, origin_conversation_label_snapshot, origin_telegram_group_id,
        author_participant_id, author_user_id, observed_at, evidence_snippet,
        timeline_entry_id, timeline_sequence, source_message_id, source_snapshot)
     VALUES ($1, $2, 'family', $2, 'primary', 'firsthand', $3, 'Family', $4, $5, $6,
             now(), 'Работа завершена по исходному плану', $7, 1, 991, '{}'::jsonb)`,
    [claim.rows[0]!.id, family.rows[0]!.id, conversation.rows[0]!.id, group.rows[0]!.id,
      participant.rows[0]!.id, user.rows[0]!.id, timeline.rows[0]!.id],
  );
  const event = await database().query<{ id: string }>(
    `INSERT INTO audit_events (family_id, actor_user_id, event_type)
     VALUES ($1, $2, 'completion.confirmed') RETURNING id`,
    [family.rows[0]!.id, user.rows[0]!.id],
  );
  const outcome = await database().query<{ id: string }>(
    `INSERT INTO confirmed_outcomes
       (family_id, scope, scope_partition_key, memory_project_id, outcome_kind, authority,
        application_event_id, source_conversation_id, source_timeline_entry_id,
        source_snapshot, summary, occurred_at)
     VALUES ($1, 'family', $1, $2, 'completion_episode', 'verified_user_statement',
             $3, $4, $5, '{}'::jsonb, 'Работа завершена', now()) RETURNING id`,
    [family.rows[0]!.id, project.rows[0]!.id, event.rows[0]!.id,
      conversation.rows[0]!.id, timeline.rows[0]!.id],
  );
  await database().query(
    `INSERT INTO confirmed_outcome_source_claims
       (outcome_id, source_claim_id, family_id, scope, scope_partition_key, source_role)
     VALUES ($1, $2, $3, 'family', $3, 'result')`,
    [outcome.rows[0]!.id, claim.rows[0]!.id, family.rows[0]!.id],
  );
  const thread = await database().query<{ id: string }>(
    `INSERT INTO memory_threads
       (family_id, scope, scope_partition_key, memory_project_id, title, purpose,
        status, completion_outcome_id, completed_at)
     VALUES ($1, 'family', $1, $2, 'Завершённая работа', 'Проверка invalidation',
             'completed', $3, now()) RETURNING id`,
    [family.rows[0]!.id, project.rows[0]!.id, outcome.rows[0]!.id],
  );
  await database().query(
    `INSERT INTO memory_thread_entries
       (thread_id, family_id, scope, scope_partition_key, source_claim_id, role, occurred_at)
     VALUES ($1, $2, 'family', $2, $3, 'goal', now())`,
    [thread.rows[0]!.id, family.rows[0]!.id, claim.rows[0]!.id],
  );
  await database().query(
    `INSERT INTO memory_thread_entries
       (thread_id, family_id, scope, scope_partition_key, source_outcome_id, role, occurred_at)
     VALUES ($1, $2, 'family', $2, $3, 'outcome', now())`,
    [thread.rows[0]!.id, family.rows[0]!.id, outcome.rows[0]!.id],
  );
  const ref = await database().query<{ memory_ref: string }>(
    "SELECT memory_ref FROM memory_item_refs WHERE memory_item_id = $1",
    [claim.rows[0]!.id],
  );
  return {
    auth: {
      familyId: family.rows[0]!.id,
      groupId: null,
      role: "owner",
      scopes: ["family"],
      telegramActorId: "completion-owner",
      telegramActorKind: "telegram_user",
      telegramUserId: "completion-owner",
      userId: user.rows[0]!.id,
    },
    memoryRef: ref.rows[0]!.memory_ref,
    outcomeId: outcome.rows[0]!.id,
    source: {
      conversationId: conversation.rows[0]!.id,
      timelineEntryId: correctionTimeline.rows[0]!.id,
    },
    threadId: thread.rows[0]!.id,
  };
}

async function expectRetractedCompletion(fixture: CompletionFixture): Promise<void> {
  await expect(database().query(
    "SELECT status::text, completion_outcome_id FROM memory_threads WHERE id = $1",
    [fixture.threadId],
  )).resolves.toMatchObject({ rows: [{ completion_outcome_id: null, status: "active" }] });
  await expect(database().query(
    "SELECT status::text FROM confirmed_outcomes WHERE id = $1",
    [fixture.outcomeId],
  )).resolves.toMatchObject({ rows: [{ status: "retracted" }] });
  await expect(database().query(
    "SELECT count(*)::integer AS count FROM memory_thread_entries WHERE source_outcome_id = $1",
    [fixture.outcomeId],
  )).resolves.toMatchObject({ rows: [{ count: 0 }] });
  await expect(database().query(
    `SELECT count(*)::integer AS count FROM memory_thread_entries AS entry
     JOIN memory_items AS claim ON claim.id = entry.source_claim_id
     WHERE entry.thread_id = $1 AND claim.claim_status <> 'active'`,
    [fixture.threadId],
  )).resolves.toMatchObject({ rows: [{ count: 0 }] });
}

describeWithDatabase("completion source invalidation", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE users, families CASCADE");
  });

  afterAll(closeDatabase);

  it("evidences a correction, transfers its thread entry, and retracts completion", async () => {
    const fixture = await createCompletionFixture();
    const corrected = await memoryRepository.updateByRef(fixture.auth, {
      content: "Работа продолжается после пересмотра результата",
      memoryRef: fixture.memoryRef,
      operationKey: "edit-completion-source",
      source: fixture.source,
    });

    await expectRetractedCompletion(fixture);
    await expect(database().query(
      `SELECT provenance_state::text, profile_eligible, origin_conversation_id,
              (SELECT count(*)::integer FROM claim_evidence WHERE claim_id = item.id) AS evidence_count
       FROM memory_items AS item WHERE id = $1`,
      [corrected.id],
    )).resolves.toMatchObject({
      rows: [{
        evidence_count: 1,
        origin_conversation_id: fixture.source.conversationId,
        profile_eligible: false,
        provenance_state: "evidenced",
      }],
    });
    await expect(database().query(
      "SELECT source_claim_id FROM memory_thread_entries WHERE thread_id = $1 AND role = 'goal'",
      [fixture.threadId],
    )).resolves.toMatchObject({ rows: [{ source_claim_id: corrected.id }] });
  });

  it("physically deletes a completion source and retracts its projections", async () => {
    const fixture = await createCompletionFixture();

    await expect(memoryRepository.deleteByRef(
      fixture.auth,
      fixture.memoryRef,
      "delete-completion-source",
    )).resolves.toEqual({ deleted: true });
    await expectRetractedCompletion(fixture);
  });
});
