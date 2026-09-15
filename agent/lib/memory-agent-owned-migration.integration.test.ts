/**
 * Main-agent-owned memory migration integration test.
 *
 * Constructs covered:
 * - Migration 059 removes future extraction retention and terminalizes unfinished provider work.
 * - Existing evidenced claims and thread history survive the architecture switch unchanged.
 * - Atomic write replay metadata gains nullable thread identity without rewriting historical rows.
 */
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;
const MIGRATION_NAME = "059_main_agent_owned_memory.sql";
const TEST_SCHEMA = "test_main_agent_owned_memory";

async function applyEarlierMigrations(client: import("pg").PoolClient): Promise<void> {
  const names = (await readdir(resolve("migrations")))
    .filter((name) => name.endsWith(".sql") && name < MIGRATION_NAME)
    .sort();
  for (const name of names) {
    await client.query(await readFile(resolve("migrations", name), "utf8"));
  }
}

describeWithDatabase("059 main-agent-owned memory migration", () => {
  afterAll(closeDatabase);

  it("retires background work while preserving claims and threads", async () => {
    const client = await database().connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      await client.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
      await client.query(`SET search_path TO ${TEST_SCHEMA}, public`);
      await applyEarlierMigrations(client);

      const family = await client.query<{ id: string }>(
        "INSERT INTO families (name) VALUES ('Migration 059') RETURNING id",
      );
      const user = await client.query<{ id: string }>(
        "INSERT INTO users (telegram_user_id, display_name) VALUES ('59001', 'Анна') RETURNING id",
      );
      await client.query(
        "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')",
        [family.rows[0]!.id, user.rows[0]!.id],
      );
      const group = await client.query<{ id: string }>(
        `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode)
         VALUES ($1, '-10059001', 'Семья', 'family_private', 'addressed_only') RETURNING id`,
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
         VALUES ($1, $2, 'family', $2, '59001', $3, 'Анна', now(), now()) RETURNING id`,
        [conversation.rows[0]!.id, family.rows[0]!.id, user.rows[0]!.id],
      );
      const message = await client.query<{ id: string }>(
        `INSERT INTO telegram_group_messages
           (conversation_id, group_id, telegram_message_id, sequence_id, actor_kind, actor_id,
            telegram_user_id, sender_display_name, sender_is_bot, message_kind, content_text, sent_at)
         VALUES ($1, $2, 59001, 1, 'user', 'telegram:59001', '59001', 'Анна', false,
                 'text', 'Подготовка к марафону началась', now()) RETURNING id`,
        [conversation.rows[0]!.id, group.rows[0]!.id],
      );
      const claim = await client.query<{ id: string }>(
        `INSERT INTO memory_items
           (family_id, author_user_id, scope, kind, content, source, confirmation, sensitivity,
            operation_key, provenance_state, origin_conversation_id, subject_user_id,
            save_approved, content_normalized, profile_eligible)
         VALUES ($1, $2, 'family', 'episode', 'Подготовка к марафону началась', 'eve:test',
                 'model_high', 'normal', 'migration-059-claim', 'evidenced', $3, $2, false,
                 'подготовка к марафону началась', true) RETURNING id`,
        [family.rows[0]!.id, user.rows[0]!.id, conversation.rows[0]!.id],
      );
      await client.query(
        `INSERT INTO claim_evidence
           (claim_id, family_id, scope, scope_partition_key, evidence_role, evidence_kind,
            origin_conversation_id, origin_conversation_label_snapshot, origin_telegram_group_id,
            author_participant_id, author_user_id, author_label_snapshot, observed_at,
            evidence_snippet, timeline_entry_id, timeline_sequence, source_message_id, source_snapshot)
         VALUES ($1, $2, 'family', $2, 'primary', 'firsthand', $3, 'Семья', $4, $5, $6,
                 'Анна', now(), 'Подготовка к марафону началась', $7, 1, 59001,
                 '{"content":"Подготовка к марафону началась"}'::jsonb)`,
        [claim.rows[0]!.id, family.rows[0]!.id, conversation.rows[0]!.id,
          group.rows[0]!.id, participant.rows[0]!.id, user.rows[0]!.id, message.rows[0]!.id],
      );
      const thread = await client.query<{ id: string }>(
        `INSERT INTO memory_threads
           (family_id, scope, scope_partition_key, subject_user_id, title, purpose)
         VALUES ($1, 'family', $1, $2, 'Марафон', 'Сохранять подготовку') RETURNING id`,
        [family.rows[0]!.id, user.rows[0]!.id],
      );
      await client.query(
        `INSERT INTO memory_thread_entries
           (thread_id, family_id, scope, scope_partition_key, source_claim_id, role, occurred_at)
         VALUES ($1, $2, 'family', $2, $3, 'goal', now())`,
        [thread.rows[0]!.id, family.rows[0]!.id, claim.rows[0]!.id],
      );

      // A pre-switch pending batch proves both the job trigger and terminal retirement semantics.
      await client.query(
        `INSERT INTO memory_extraction_batches
           (conversation_id, family_id, scope, scope_partition_key, caller_user_id, batch_kind,
            caller_telegram_user_id, turn_id, extractor_version, schema_version,
            request_identity_hash, input_payload_hash)
         VALUES ($1, $2, 'family', $2, $3, 'catchup', '59001', 'migration-059-turn',
                 'semantic-extractor-v1', 'memory-candidate-v2', repeat('a', 64), repeat('b', 64))`,
        [conversation.rows[0]!.id, family.rows[0]!.id, user.rows[0]!.id],
      );
      expect((await client.query("SELECT count(*)::integer AS count FROM memory_extraction_retention_holds"))
        .rows).toEqual([{ count: 1 }]);

      await client.query(await readFile(resolve("migrations", MIGRATION_NAME), "utf8"));

      expect((await client.query(
        `SELECT
           (SELECT count(*)::integer FROM memory_items WHERE id = $1) AS claims,
           (SELECT count(*)::integer FROM memory_threads WHERE id = $2) AS threads,
           (SELECT count(*)::integer FROM memory_thread_entries WHERE source_claim_id = $1) AS entries,
           (SELECT count(*)::integer FROM memory_extraction_retention_holds) AS holds,
           (SELECT count(*)::integer FROM memory_extraction_jobs WHERE status = 'failed') AS failed_jobs`,
        [claim.rows[0]!.id, thread.rows[0]!.id],
      )).rows).toEqual([{ claims: 1, entries: 1, failed_jobs: 1, holds: 0, threads: 1 }]);
      expect((await client.query(
        `SELECT count(*)::integer AS count FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'memory_mutation_operations'
           AND column_name IN ('thread_id', 'thread_action')`,
        [TEST_SCHEMA],
      )).rows).toEqual([{ count: 2 }]);

      await client.query(
        `INSERT INTO telegram_group_messages
           (conversation_id, group_id, telegram_message_id, sequence_id, actor_kind, actor_id,
            telegram_user_id, sender_display_name, sender_is_bot, message_kind, content_text, sent_at)
         VALUES ($1, $2, 59002, 2, 'user', 'telegram:59001', '59001', 'Анна', false,
                 'text', 'Новое сообщение не удерживается extraction', now())`,
        [conversation.rows[0]!.id, group.rows[0]!.id],
      );
      expect((await client.query("SELECT count(*)::integer AS count FROM memory_extraction_retention_holds"))
        .rows).toEqual([{ count: 0 }]);
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
