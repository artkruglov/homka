/**
 * Migration 080 erroneous personal memory-review artifact cleanup tests.
 *
 * Constructs covered:
 * - Cleanup requires the exact inspected production batch, sources, and two legacy personal lanes.
 * - Changed evidence aborts the migration atomically.
 * - Cleanup preserves the personal timeline and records the destructive operator action.
 */
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";

const integrationTestsEnabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const integrationDatabaseUrl = process.env.DATABASE_URL;

if (integrationTestsEnabled) {
  if (!integrationDatabaseUrl) {
    throw new Error("AGENT_TEST_DATABASE_CONFIG_MISSING: Для integration-тестов не задан DATABASE_URL");
  }
  if (!new URL(integrationDatabaseUrl).pathname.slice(1).endsWith("_test")) {
    throw new Error(
      "AGENT_TEST_DATABASE_UNSAFE: Integration-тесты разрешены только для БД с суффиксом _test",
    );
  }
}

const describeWithDatabase = integrationTestsEnabled ? describe : describe.skip;
const MIGRATION_NAME = "080_remove_personal_memory_review_artifacts.sql";
const MIGRATION_ORDINAL = 80;
const TEST_SCHEMA = "test_personal_memory_review_cleanup";
const FAMILY_ID = "13a6d926-5c7d-4dee-8b3b-a8d5762a760e";
const FIRST_OWNER_ID = "d09d5ffa-c516-4d38-bde5-28f6b63e193c";
const SECOND_OWNER_ID = "d7d05997-b2b5-4198-a60c-61e999b947c6";
const FIRST_CONVERSATION_ID = "dd1ac651-2842-4914-b429-a32e04fec7fe";
const SECOND_CONVERSATION_ID = "3b36f261-619a-4ca3-a38d-14cce824be59";
const FIRST_LANE_ID = "5417e534-12cb-466b-b7d0-193c97337307";
const INCIDENT_LANE_ID = "b6ccb4e0-926b-43c8-8789-fdc8b0a274ad";
const INCIDENT_BATCH_ID = "173c6d02-b781-4515-9c1f-562c9b1ee415";
const SOURCE_SEQUENCES = [
  87, 89, 91, 93, 95, 97, 99, 101, 102, 104, 106, 108, 110, 112, 114, 116, 118,
  120, 122, 123, 125, 127, 129, 131, 132, 133, 134, 136, 138, 140, 142, 144, 146,
  147, 149, 151, 153, 155, 157, 158, 159, 161, 163, 165, 166, 168, 170, 172, 174,
  176,
];
const MIGRATION_NAME_PATTERN = /^(\d+)_.*\.sql$/u;

function migrationOrdinal(name: string): number | null {
  const match = MIGRATION_NAME_PATTERN.exec(name);
  return match ? Number.parseInt(match[1]!, 10) : null;
}

async function applyEarlierMigrations(client: import("pg").PoolClient): Promise<void> {
  const names = (await readdir(resolve("migrations")))
    .filter((name) => {
      const ordinal = migrationOrdinal(name);
      return ordinal !== null && ordinal < MIGRATION_ORDINAL;
    })
    .sort((left, right) => {
      const difference = migrationOrdinal(left)! - migrationOrdinal(right)!;
      return difference || left.localeCompare(right);
    });
  for (const name of names) {
    await client.query(await readFile(resolve("migrations", name), "utf8"));
  }
}

describeWithDatabase("078 personal memory-review artifact cleanup", () => {
  afterAll(closeDatabase);

  it("removes only the exact personal artifacts and aborts atomically on changed evidence", async () => {
    const client = await database().connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      await client.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
      await client.query(`SET search_path TO ${TEST_SCHEMA}, public`);
      await applyEarlierMigrations(client);

      await client.query("INSERT INTO families (id, name) VALUES ($1, 'Personal cleanup')", [FAMILY_ID]);
      await client.query(
        `INSERT INTO users (id, telegram_user_id, display_name) VALUES
           ($1, 'personal-cleanup-one', 'Первый'),
           ($2, 'personal-cleanup-two', 'Второй')`,
        [FIRST_OWNER_ID, SECOND_OWNER_ID],
      );
      await client.query(
        `INSERT INTO application_conversations
           (id, family_id, owner_user_id, telegram_chat_id, scope, scope_partition_key, label)
         VALUES
           ($1, $2, $3, 'personal-cleanup-one', 'personal', $3, 'Первый'),
           ($4, $2, $5, 'personal-cleanup-two', 'personal', $5, 'Второй')`,
        [FIRST_CONVERSATION_ID, FAMILY_ID, FIRST_OWNER_ID, SECOND_CONVERSATION_ID, SECOND_OWNER_ID],
      );
      await client.query(
        `INSERT INTO family_memberships (family_id, user_id, role) VALUES
           ($1, $2, 'owner'), ($1, $3, 'member')`,
        [FAMILY_ID, FIRST_OWNER_ID, SECOND_OWNER_ID],
      );
      const migration = await readFile(resolve("migrations", MIGRATION_NAME), "utf8");
      await expect(client.query(migration)).rejects.toThrow(
        "AGENT_MEMORY_REVIEW_PERSONAL_CLEANUP_ARTIFACTS_MISSING",
      );
      await client.query(
        "DELETE FROM application_conversations WHERE id IN ($1, $2)",
        [FIRST_CONVERSATION_ID, SECOND_CONVERSATION_ID],
      );
      await expect(client.query(migration)).rejects.toThrow(
        "AGENT_MEMORY_REVIEW_PERSONAL_CLEANUP_ARTIFACTS_MISSING",
      );
      await client.query(
        `INSERT INTO application_conversations
           (id, family_id, owner_user_id, telegram_chat_id, scope, scope_partition_key, label)
         VALUES
           ($1, $2, $3, 'personal-cleanup-one', 'personal', $3, 'Первый'),
           ($4, $2, $5, 'personal-cleanup-two', 'personal', $5, 'Второй')`,
        [FIRST_CONVERSATION_ID, FAMILY_ID, FIRST_OWNER_ID, SECOND_CONVERSATION_ID, SECOND_OWNER_ID],
      );
      const participant = await client.query<{ id: string }>(
        `INSERT INTO conversation_participants
           (conversation_id, family_id, scope, scope_partition_key, telegram_user_id,
            linked_user_id, display_name_snapshot, first_observed_at, last_observed_at)
         VALUES ($1, $2, 'personal', $3, 'personal-cleanup-two', $3, 'Второй', now(), now())
         RETURNING id`,
        [SECOND_CONVERSATION_ID, FAMILY_ID, SECOND_OWNER_ID],
      );
      const group = await client.query<{ id: string }>(
        `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode)
         VALUES ($1, '-100-personal-cleanup', 'Unrelated group', 'external', 'addressed_only')
         RETURNING id`,
        [FAMILY_ID],
      );
      const groupConversation = await client.query<{ id: string }>(
        "SELECT id FROM application_conversations WHERE telegram_group_id = $1",
        [group.rows[0]!.id],
      );
      const groupLane = await client.query<{ id: string }>(
        `INSERT INTO memory_review_lanes (conversation_id, processed_through_sequence)
         VALUES ($1, 0) RETURNING id`,
        [groupConversation.rows[0]!.id],
      );
      await client.query(
        `INSERT INTO telegram_group_messages
           (conversation_id, telegram_message_id, sequence_id, actor_kind, actor_id,
            telegram_user_id, sender_display_name, sender_is_bot, message_kind, content_text, sent_at)
         SELECT $1, sequence, sequence, 'user', 'telegram:personal-cleanup-two',
                'personal-cleanup-two', 'Второй', false, 'text', 'Сообщение ' || sequence, now()
           FROM unnest($2::bigint[]) AS sequence`,
        [SECOND_CONVERSATION_ID, SOURCE_SEQUENCES],
      );
      await client.query(
        `INSERT INTO memory_review_lanes
           (id, conversation_id, processed_through_sequence) VALUES
           ($1, $2, 19), ($3, $4, 85)`,
        [FIRST_LANE_ID, FIRST_CONVERSATION_ID, INCIDENT_LANE_ID, SECOND_CONVERSATION_ID],
      );
      await client.query(
        `INSERT INTO memory_review_batches
           (id, lane_id, conversation_id, batch_kind, status, predecessor_sequence,
            from_sequence, through_sequence, source_count)
         VALUES ($1, $2, $3, 'background', 'pending', 85, 87, 176, 50)`,
        [INCIDENT_BATCH_ID, INCIDENT_LANE_ID, SECOND_CONVERSATION_ID],
      );
      await client.query(
        `INSERT INTO memory_review_batch_sources
           (batch_id, conversation_id, timeline_entry_id, timeline_sequence)
         SELECT $1, $2, id, sequence_id FROM telegram_group_messages
          WHERE conversation_id = $2`,
        [INCIDENT_BATCH_ID, SECOND_CONVERSATION_ID],
      );
      const claim = await client.query<{ id: string }>(
        `INSERT INTO memory_items
           (family_id, owner_user_id, author_user_id, author_telegram_user_id, scope, kind,
            content, source, confirmation, sensitivity, operation_key, provenance_state,
            origin_conversation_id, subject_user_id, profile_eligible)
         VALUES ($1, $2, $2, 'personal-cleanup-two', 'personal', 'fact',
                 'Сохранённый personal claim', 'migration:test', 'model_high', 'normal',
                 'personal-cleanup-claim', 'evidenced', $3, $2, true)
         RETURNING id`,
        [FAMILY_ID, SECOND_OWNER_ID, SECOND_CONVERSATION_ID],
      );
      await client.query(
        `INSERT INTO claim_evidence
           (claim_id, family_id, scope, scope_partition_key, evidence_role, evidence_kind,
            origin_conversation_id, origin_conversation_label_snapshot, author_participant_id,
            author_user_id, author_label_snapshot, observed_at, evidence_snippet,
            timeline_entry_id, timeline_sequence, source_message_id, source_snapshot)
         SELECT $1, $2, 'personal', $3, 'primary', 'firsthand', $4, 'Второй', $5, $3,
                'Второй', now(), 'Сохранённый personal claim', id, sequence_id,
                telegram_message_id, jsonb_build_object('content', content_text)
           FROM telegram_group_messages WHERE conversation_id = $4 AND sequence_id = 87`,
        [claim.rows[0]!.id, FAMILY_ID, SECOND_OWNER_ID, SECOND_CONVERSATION_ID,
          participant.rows[0]!.id],
      );

      await client.query(
        "UPDATE memory_review_lanes SET processed_through_sequence = 86 WHERE id = $1",
        [INCIDENT_LANE_ID],
      );
      await expect(client.query(migration)).rejects.toThrow(
        "AGENT_MEMORY_REVIEW_PERSONAL_CLEANUP_LANES_INVALID",
      );
      await expect(client.query(
        "SELECT count(*)::integer AS count FROM memory_review_lanes WHERE id IN ($1, $2)",
        [FIRST_LANE_ID, INCIDENT_LANE_ID],
      )).resolves.toMatchObject({ rows: [{ count: 2 }] });
      await client.query(
        "UPDATE memory_review_lanes SET processed_through_sequence = 85 WHERE id = $1",
        [INCIDENT_LANE_ID],
      );
      await client.query(
        "DELETE FROM memory_review_batch_sources WHERE batch_id = $1 AND timeline_sequence = 176",
        [INCIDENT_BATCH_ID],
      );
      await expect(client.query(migration)).rejects.toThrow(
        "AGENT_MEMORY_REVIEW_PERSONAL_CLEANUP_SOURCES_INVALID",
      );
      await client.query(
        `INSERT INTO memory_review_batch_sources
           (batch_id, conversation_id, timeline_entry_id, timeline_sequence)
         SELECT $1, $2, id, sequence_id FROM telegram_group_messages
          WHERE conversation_id = $2 AND sequence_id = 176`,
        [INCIDENT_BATCH_ID, SECOND_CONVERSATION_ID],
      );

      await client.query(migration);
      await client.query(migration);

      await expect(client.query(
        `SELECT
           (SELECT count(*)::integer FROM memory_review_lanes) AS lane_count,
           (SELECT count(*)::integer FROM memory_review_batches) AS batch_count,
           (SELECT count(*)::integer FROM memory_review_batch_sources) AS source_count,
           (SELECT count(*)::integer FROM memory_review_lanes
             WHERE id = $2) AS group_lane_count,
           (SELECT count(*)::integer FROM telegram_group_messages
              WHERE conversation_id = $1) AS timeline_count,
           (SELECT count(*)::integer FROM claim_evidence
             WHERE claim_id = $3 AND timeline_entry_id IS NOT NULL) AS evidence_count,
           (SELECT count(*)::integer FROM audit_events
             WHERE event_type = 'memory_review.personal_artifact_removed') AS audit_count`,
        [SECOND_CONVERSATION_ID, groupLane.rows[0]!.id, claim.rows[0]!.id],
      )).resolves.toMatchObject({ rows: [{
        audit_count: 2,
        batch_count: 0,
        evidence_count: 1,
        group_lane_count: 1,
        lane_count: 1,
        source_count: 0,
        timeline_count: 50,
      }] });
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      await client.query("RESET search_path");
      client.release();
    }
  });
});
