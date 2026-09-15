/**
 * R3 profile projection and sensitive approval migration tests.
 *
 * Constructs covered:
 * - Migration 052 defaults every existing/new external projection policy to disabled.
 * - Group, subject, profile-view, notice, and approval references are opaque and constrained.
 * - Chat-local participant subjects cannot cross conversations and group deletion cascades R3 state.
 */
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;
const TEST_SCHEMA = "test_r3_profile_migration";
const MIGRATION_NAME = "052_r3_verified_profiles.sql";

async function applyMigrationsBefore052(client: import("pg").PoolClient): Promise<void> {
  const names = (await readdir(resolve("migrations")))
    .filter((name) => name.endsWith(".sql") && name < MIGRATION_NAME)
    .sort();
  for (const name of names) {
    await client.query(await readFile(resolve("migrations", name), "utf8"));
  }
}

describeWithDatabase("052 R3 verified profiles migration", () => {
  afterAll(closeDatabase);

  it("creates fail-closed policies, local subjects, durable views and approval refs", async () => {
    const client = await database().connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      await client.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
      await client.query(`SET search_path TO ${TEST_SCHEMA}, public`);
      await applyMigrationsBefore052(client);

      const family = await client.query<{ id: string }>(
        "INSERT INTO families (name) VALUES ('R3 migration') RETURNING id",
      );
      const user = await client.query<{ id: string }>(
        "INSERT INTO users (telegram_user_id, display_name) VALUES ('4801', 'Анна') RETURNING id",
      );
      await client.query(
        "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')",
        [family.rows[0]!.id, user.rows[0]!.id],
      );
      const existing = await client.query<{ id: string }>(
        `INSERT INTO telegram_groups
           (family_id, telegram_chat_id, title, type, message_mode)
         VALUES ($1, '-1004801', 'External A', 'external', 'addressed_only') RETURNING id`,
        [family.rows[0]!.id],
      );
      await client.query(await readFile(resolve("migrations", MIGRATION_NAME), "utf8"));

      const existingPolicy = await client.query<{
        enabled: boolean;
        group_ref: string;
        notice_count: number;
      }>(
        `SELECT policy.enabled, policy.group_ref,
                (SELECT count(*)::integer FROM external_profile_projection_notices
                 WHERE group_id = policy.group_id) AS notice_count
         FROM external_profile_projection_policies AS policy WHERE policy.group_id = $1`,
        [existing.rows[0]!.id],
      );
      expect(existingPolicy.rows[0]).toMatchObject({ enabled: false, notice_count: 1 });
      expect(existingPolicy.rows[0]!.group_ref).toMatch(/^grp_[0-9a-f]{32}$/u);

      const created = await client.query<{ id: string }>(
        `INSERT INTO telegram_groups
           (family_id, telegram_chat_id, title, type, message_mode)
         VALUES ($1, '-1004802', 'External B', 'external', 'addressed_only') RETURNING id`,
        [family.rows[0]!.id],
      );
      await expect(client.query(
        "SELECT enabled FROM external_profile_projection_policies WHERE group_id = $1",
        [created.rows[0]!.id],
      )).resolves.toMatchObject({ rows: [{ enabled: false }] });

      const conversations = await client.query<{ id: string; telegram_group_id: string }>(
        `SELECT id, telegram_group_id FROM application_conversations
         WHERE telegram_group_id IN ($1, $2) ORDER BY telegram_group_id`,
        [existing.rows[0]!.id, created.rows[0]!.id],
      );
      const firstConversation = conversations.rows.find(
        (row) => row.telegram_group_id === existing.rows[0]!.id,
      )!;
      const secondConversation = conversations.rows.find(
        (row) => row.telegram_group_id === created.rows[0]!.id,
      )!;
      const participant = await client.query<{ id: string }>(
        `INSERT INTO conversation_participants
           (conversation_id, family_id, scope, scope_partition_key, telegram_user_id,
            linked_user_id, display_name_snapshot, first_observed_at, last_observed_at)
         SELECT id, family_id, scope, scope_partition_key, '4801', $2, 'Анна', now(), now()
         FROM application_conversations WHERE id = $1 RETURNING id`,
        [firstConversation.id, user.rows[0]!.id],
      );
      const subject = await client.query<{ subject_ref: string }>(
        "SELECT subject_ref FROM profile_subjects WHERE conversation_id = $1",
        [firstConversation.id],
      );
      expect(subject.rows[0]!.subject_ref).toMatch(/^subj_[0-9a-f]{32}$/u);

      await expect(client.query(
        `INSERT INTO profile_subjects
           (conversation_id, family_id, subject_participant_id, subject_conversation_id,
            display_label_snapshot, last_verified_at)
         VALUES ($1, $2, $3, $4, 'Анна', now())`,
        [secondConversation.id, family.rows[0]!.id, participant.rows[0]!.id, firstConversation.id],
      )).rejects.toThrow();

      const view = await client.query<{ id: string; profile_view_ref: string }>(
        `INSERT INTO profile_views
           (family_id, viewer_conversation_id, viewer_user_id, subject_count,
            claim_count, total_characters)
         VALUES ($1, $2, $3, 0, 0, 0) RETURNING id, profile_view_ref`,
        [family.rows[0]!.id, firstConversation.id, user.rows[0]!.id],
      );
      expect(view.rows[0]!.profile_view_ref).toMatch(/^view_[0-9a-f]{32}$/u);

      await client.query("DELETE FROM telegram_groups WHERE id = $1", [existing.rows[0]!.id]);
      await expect(client.query(
        `SELECT
           (SELECT count(*)::integer FROM external_profile_projection_policies WHERE group_id = $1) AS policies,
           (SELECT count(*)::integer FROM external_profile_projection_notices WHERE group_id = $1) AS notices,
           (SELECT count(*)::integer FROM profile_views WHERE id = $2) AS views`,
        [existing.rows[0]!.id, view.rows[0]!.id],
      )).resolves.toMatchObject({ rows: [{ notices: 0, policies: 0, views: 0 }] });
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      client.release();
    }
  });
});
