/**
 * R6/R7 memory-thread schema and lifecycle integration tests.
 *
 * Covers migration preservation, scoped outcomes/projects, source identity, hierarchy, invalidation,
 * and safe deletion of external and family Telegram conversation state.
 * Cascade graph setup and assertions live in the colocated integration scenario module.
 */
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";
import { verifyR6CascadeDeletion } from "./r6-r7-memory-thread-migration.integration-scenarios.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;
const TEST_SCHEMA = "test_r6_r7_memory_threads";
const MIGRATION_NAME = "054_r6_r7_memory_threads.sql";

async function applyEarlierMigrations(client: import("pg").PoolClient): Promise<void> {
  const names = (await readdir(resolve("migrations")))
    .filter((name) => name.endsWith(".sql") && name < MIGRATION_NAME)
    .sort();
  for (const name of names) {
    await client.query(await readFile(resolve("migrations", name), "utf8"));
  }
}

describeWithDatabase("054 R6/R7 memory threads migration", () => {
  afterAll(closeDatabase);

  it("preserves claims and enforces source, identity, scope, hierarchy, and invalidation", async () => {
    const client = await database().connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      await client.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
      await client.query(`SET search_path TO ${TEST_SCHEMA}, public`);
      await applyEarlierMigrations(client);

      // Build one verified family source before applying the additive migration.
      const family = await client.query<{ id: string }>(
        "INSERT INTO families (name) VALUES ('Threads') RETURNING id",
      );
      const users = await client.query<{ id: string }>(
        `INSERT INTO users (telegram_user_id, display_name)
         VALUES ('thread-owner', 'Owner'), ('thread-member', 'Member') RETURNING id`,
      );
      await client.query(
        `INSERT INTO family_memberships (family_id, user_id, role)
         VALUES ($1, $2, 'owner'), ($1, $3, 'member')`,
        [family.rows[0]!.id, users.rows[0]!.id, users.rows[1]!.id],
      );
      const group = await client.query<{ id: string }>(
        `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode)
         VALUES ($1, '-100650', 'Family source', 'family_private', 'addressed_only') RETURNING id`,
        [family.rows[0]!.id],
      );
      const conversation = await client.query<{ id: string }>(
        "SELECT id FROM application_conversations WHERE telegram_group_id = $1",
        [group.rows[0]!.id],
      );
      const participant = await client.query<{ id: string }>(
        `INSERT INTO conversation_participants
           (conversation_id, family_id, scope, scope_partition_key, telegram_user_id,
            linked_user_id, display_name_snapshot, first_observed_at, last_observed_at)
         VALUES ($1, $2, 'family', $2, 'thread-owner', $3, 'Owner', now(), now()) RETURNING id`,
        [conversation.rows[0]!.id, family.rows[0]!.id, users.rows[0]!.id],
      );
      const timeline = await client.query<{ id: string }>(
        `INSERT INTO telegram_group_messages
           (group_id, conversation_id, telegram_message_id, sequence_id, actor_kind, actor_id,
            telegram_user_id, sender_display_name, sender_is_bot, message_kind, content_text, sent_at)
         VALUES ($1, $2, 650, 1, 'user', 'telegram:thread-owner', 'thread-owner',
                 'Owner', false, 'text', 'Буду регулярно тренироваться', now()) RETURNING id`,
        [group.rows[0]!.id, conversation.rows[0]!.id],
      );
      const claims = await client.query<{ id: string }>(
        `INSERT INTO memory_items
           (family_id, author_user_id, scope, kind, content, source, confirmation, sensitivity,
            operation_key, provenance_state, origin_conversation_id, subject_user_id,
            save_approved, content_normalized, profile_eligible)
         VALUES ($1, $2, 'family', 'fact', 'Тренироваться трижды в неделю', 'extraction',
                 'model_high', 'normal', 'thread-evidenced', 'evidenced', $3, $2, true,
                 'тренироваться трижды в неделю', true),
                ($1, $2, 'family', 'fact', 'Запись без evidence', 'explicit',
                 'user_confirmed', 'normal', 'thread-unsupported', 'legacy_unresolved', NULL, $2,
                 NULL, 'запись без evidence', false)
         RETURNING id`,
        [family.rows[0]!.id, users.rows[0]!.id, conversation.rows[0]!.id],
      );
      await client.query(
        `INSERT INTO claim_evidence
           (claim_id, family_id, scope, scope_partition_key, evidence_role, evidence_kind,
            origin_conversation_id, origin_conversation_label_snapshot, origin_telegram_group_id,
            author_participant_id, author_user_id, author_label_snapshot, observed_at,
            evidence_snippet, timeline_entry_id, timeline_sequence, source_message_id, source_snapshot)
         VALUES ($1, $2, 'family', $2, 'primary', 'firsthand', $3, 'Family source', $4,
                 $5, $6, 'Owner', now(), 'Буду регулярно тренироваться', $7, 1, 650,
                 '{"content":"Буду регулярно тренироваться"}'::jsonb)`,
        [claims.rows[0]!.id, family.rows[0]!.id, conversation.rows[0]!.id, group.rows[0]!.id,
          participant.rows[0]!.id, users.rows[0]!.id, timeline.rows[0]!.id],
      );
      const before = await client.query("SELECT id, content FROM memory_items ORDER BY operation_key");

      await client.query(await readFile(resolve("migrations", MIGRATION_NAME), "utf8"));
      expect((await client.query("SELECT id, content FROM memory_items ORDER BY operation_key")).rows)
        .toEqual(before.rows);

      // Same subject/scope claims may attach to multiple broad or focused threads without copying.
      const roots = await client.query<{ id: string }>(
        `INSERT INTO memory_threads
           (family_id, scope, scope_partition_key, subject_user_id, title, purpose)
         VALUES ($1, 'family', $1, $2, 'Тренировки', 'План и результаты'),
                ($1, 'family', $1, $2, 'Здоровье', 'Ограничения тренировок') RETURNING id`,
        [family.rows[0]!.id, users.rows[0]!.id],
      );
      await client.query(
        `INSERT INTO memory_thread_entries
           (thread_id, family_id, scope, scope_partition_key, source_claim_id, role, occurred_at)
         VALUES ($1, $3, 'family', $3, $4, 'method', now()),
                ($2, $3, 'family', $3, $4, 'constraint', now())`,
        [roots.rows[0]!.id, roots.rows[1]!.id, family.rows[0]!.id, claims.rows[0]!.id],
      );
      await expect(client.query(
        `INSERT INTO memory_thread_entries
           (thread_id, family_id, scope, scope_partition_key, source_claim_id, role, occurred_at)
         VALUES ($1, $2, 'family', $2, $3, 'goal', now())`,
        [roots.rows[0]!.id, family.rows[0]!.id, claims.rows[1]!.id],
      )).rejects.toThrow(/AGENT_MEMORY_THREAD_SOURCE_REQUIRED/u);

      // Root plus one subthread is accepted; a grandchild is rejected by the hierarchy trigger.
      const child = await client.query<{ id: string }>(
        `INSERT INTO memory_threads
           (family_id, scope, scope_partition_key, subject_user_id, parent_thread_id, title, purpose)
         VALUES ($1, 'family', $1, $2, $3, 'Марафон 2027', 'Подготовка к забегу') RETURNING id`,
        [family.rows[0]!.id, users.rows[0]!.id, roots.rows[0]!.id],
      );
      await expect(client.query(
        `INSERT INTO memory_threads
           (family_id, scope, scope_partition_key, subject_user_id, parent_thread_id, title, purpose)
         VALUES ($1, 'family', $1, $2, $3, 'Глубже', 'Запрещённый третий уровень')`,
        [family.rows[0]!.id, users.rows[0]!.id, child.rows[0]!.id],
      )).rejects.toThrow(/AGENT_MEMORY_THREAD_DEPTH_INVALID/u);

      // A cached brief is deleted and every linked thread generation advances in the same mutation.
      const brief = await client.query<{ id: string }>(
        `INSERT INTO memory_thread_briefs
           (thread_id, generation, model_version, schema_version, total_characters, item_count)
         SELECT id, generation, 'model-v1', 'schema-v1', 20, 1 FROM memory_threads WHERE id = $1
         RETURNING id`,
        [roots.rows[0]!.id],
      );
      const entry = await client.query<{ id: string }>(
        "SELECT id FROM memory_thread_entries WHERE thread_id = $1",
        [roots.rows[0]!.id],
      );
      await client.query(
        `INSERT INTO memory_thread_brief_blocks
           (brief_id, thread_id, ordinal, kind, content)
         VALUES ($1, $2, 0, 'method', 'Трижды в неделю')`,
        [brief.rows[0]!.id, roots.rows[0]!.id],
      );
      await client.query(
        `INSERT INTO memory_thread_brief_block_sources
           (brief_id, block_ordinal, thread_id, thread_entry_id)
         VALUES ($1, 0, $2, $3)`,
        [brief.rows[0]!.id, roots.rows[0]!.id, entry.rows[0]!.id],
      );
      const generationsBefore = await client.query<{ generation: number; id: string }>(
        "SELECT id, generation FROM memory_threads WHERE id = ANY($1::uuid[]) ORDER BY id",
        [roots.rows.map((row) => row.id)],
      );
      await client.query("UPDATE memory_items SET content = 'Тренироваться дважды в неделю' WHERE id = $1", [claims.rows[0]!.id]);
      expect((await client.query("SELECT count(*)::integer AS count FROM memory_thread_briefs")).rows)
        .toEqual([{ count: 0 }]);
      const generationsAfter = await client.query<{ generation: number; id: string }>(
        "SELECT id, generation FROM memory_threads WHERE id = ANY($1::uuid[]) ORDER BY id",
        [roots.rows.map((row) => row.id)],
      );
      expect(generationsAfter.rows.map((row) => row.generation))
        .toEqual(generationsBefore.rows.map((row) => row.generation + 1));

      // Relation, conflict, lifecycle, and deletion mutations share the same synchronous invalidation path.
      const cacheRootBrief = async (modelVersion: string) => {
        const cached = await client.query<{ id: string }>(
          `INSERT INTO memory_thread_briefs
             (thread_id, generation, model_version, schema_version, total_characters, item_count)
           SELECT id, generation, $2, 'schema-v1', 20, 1 FROM memory_threads WHERE id = $1
           RETURNING id`,
          [roots.rows[0]!.id, modelVersion],
        );
        await client.query(
          `INSERT INTO memory_thread_brief_blocks
             (brief_id, thread_id, ordinal, kind, content)
           VALUES ($1, $2, 0, 'method', 'Трижды в неделю')`,
          [cached.rows[0]!.id, roots.rows[0]!.id],
        );
        await client.query(
          `INSERT INTO memory_thread_brief_block_sources
             (brief_id, block_ordinal, thread_id, thread_entry_id)
           VALUES ($1, 0, $2, $3)`,
          [cached.rows[0]!.id, roots.rows[0]!.id, entry.rows[0]!.id],
        );
      };
      const rootGeneration = async () => Number((await client.query<{ generation: number }>(
        "SELECT generation FROM memory_threads WHERE id = $1",
        [roots.rows[0]!.id],
      )).rows[0]!.generation);

      await cacheRootBrief("model-relation");
      let previousGeneration = await rootGeneration();
      await client.query(
        `INSERT INTO claim_relations
           (source_claim_id, target_claim_id, family_id, scope, scope_partition_key,
            relation_type, detection_method)
         VALUES ($1, $2, $3, 'family', $3, 'refinement', 'model_guarded')`,
        [claims.rows[0]!.id, claims.rows[1]!.id, family.rows[0]!.id],
      );
      expect(await rootGeneration()).toBe(previousGeneration + 1);
      expect((await client.query("SELECT count(*)::integer AS count FROM memory_thread_briefs")).rows)
        .toEqual([{ count: 0 }]);

      await cacheRootBrief("model-conflict");
      previousGeneration = await rootGeneration();
      await client.query(
        `INSERT INTO claim_conflicts
           (claim_a_id, claim_b_id, family_id, scope, scope_partition_key, detection_method)
         VALUES (LEAST($1::uuid, $2::uuid), GREATEST($1::uuid, $2::uuid),
                 $3, 'family', $3, 'model_guarded')`,
        [claims.rows[0]!.id, claims.rows[1]!.id, family.rows[0]!.id],
      );
      expect(await rootGeneration()).toBe(previousGeneration + 1);
      expect((await client.query("SELECT count(*)::integer AS count FROM memory_thread_briefs")).rows)
        .toEqual([{ count: 0 }]);

      await cacheRootBrief("model-lifecycle");
      previousGeneration = await rootGeneration();
      await client.query(
        `UPDATE memory_items SET claim_status = 'superseded', superseded_by = $2, updated_at = now()
         WHERE id = $1`,
        [claims.rows[0]!.id, claims.rows[1]!.id],
      );
      expect(await rootGeneration()).toBe(previousGeneration + 1);
      expect((await client.query("SELECT count(*)::integer AS count FROM memory_thread_briefs")).rows)
        .toEqual([{ count: 0 }]);
      previousGeneration = await rootGeneration();
      await client.query("DELETE FROM memory_items WHERE id = $1", [claims.rows[0]!.id]);
      // Deleting an already detached inactive claim must not invalidate the thread a second time.
      expect(await rootGeneration()).toBe(previousGeneration);
      expect((await client.query(
        "SELECT count(*)::integer AS count FROM memory_thread_entries WHERE thread_id = $1",
        [roots.rows[0]!.id],
      )).rows).toEqual([{ count: 0 }]);
    } finally {
      try {
        await client.query("RESET search_path");
        await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      } finally {
        client.release();
      }
    }
  });

  it("deletes external R6 roots and safely erases family-conversation provenance", async () => {
    const client = await database().connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      await client.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
      await client.query(`SET search_path TO ${TEST_SCHEMA}, public`);
      await applyEarlierMigrations(client);

      await verifyR6CascadeDeletion(
        client,
        await readFile(resolve("migrations", MIGRATION_NAME), "utf8"),
      );
    } finally {
      try {
        await client.query("RESET search_path");
        await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      } finally {
        client.release();
      }
    }
  });
});
