/**
 * Production-ledger memory upgrade integration test.
 *
 * Key constructs:
 * - `V0101_LEDGER`: exact production v0.10.1 migration names through release number 048.
 * - `MEMORY_RELEASE_MIGRATIONS`: memory migrations through the main-agent ownership cutover.
 * - `POST_V0101_MIGRATIONS`: every current migration the production-ledger fixture must apply.
 * - `runMigrationRunner`: executes the real migration entrypoint against an isolated test schema.
 * - Upgrade scenario: verifies ledger delta, unique purposes, R0-R7 objects, and review recovery.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;
const TEST_SCHEMA = "test_memory_upgrade_ledger";
const MIGRATION_FILE_PATTERN = /^\d{3}_.+\.sql$/u;
const execFileAsync = promisify(execFile);

const V0101_LEDGER = [
  "001_initial.sql",
  "002_invitations.sql",
  "002_routine_observations.sql",
  "003_telegram_group_journal.sql",
  "004_external_group_tool_policy.sql",
  "005_telegram_durable_ingress.sql",
  "006_hybrid_memory.sql",
  "007_memory_exports.sql",
  "008_e5_memory_embedding_chunks.sql",
  "009_reminders.sql",
  "010_google_calendar_integration.sql",
  "012_task_overdue_and_shopping_lists.sql",
  "013_sessions_and_workspaces.sql",
  "014_workspace_file_deliveries.sql",
  "015_filesystem_first_workspaces.sql",
  "016_remove_workspace_file_tool_allowlists.sql",
  "017_remove_shopping_and_routine_subsystems.sql",
  "018_telegram_hitl_approvals.sql",
  "019_remove_document_parser.sql",
  "020_reject_external_media_ingress.sql",
  "021_tombstone_ignored_telegram_media.sql",
  "022_remove_legacy_group_media_payloads.sql",
  "023_software_updates.sql",
  "024_google_workspace_integration.sql",
  "025_native_gws_workspace_profiles.sql",
  "026_native_gws_workspace_constraints.sql",
  "027_remove_google_workspace_api_proxy_operations.sql",
  "028_remove_tasks.sql",
  "029_agent_schedules.sql",
  "030_proactive_delivery_history.sql",
  "031_lazy_family_attachments.sql",
  "032_normalize_group_journal_forum_topics.sql",
  "033_unified_telegram_group_timeline.sql",
  "034_durable_group_session_context.sql",
  "035_semantic_telegram_approvals.sql",
  "036_agent_timeline_attachments.sql",
  "037_repair_delivered_agent_schedule_runs.sql",
  "038_clear_group_session_cursors_on_retirement.sql",
  "039_external_group_owner_only_mode.sql",
  "040_restrict_owner_only_to_external_groups.sql",
  "041_consolidate_external_group_type.sql",
  "042_canonical_group_task_sessions.sql",
  "043_reply_attachment_source.sql",
  "044_telegram_group_skill_allowlist.sql",
  "045_memory_operation_provenance.sql",
  "046_invitation_delivery_attempts.sql",
  "047_remove_external_web_search_grants.sql",
  "048_oauth_authorization_delivery_state.sql",
] as const;

const MEMORY_RELEASE_MIGRATIONS = [
  "049_opaque_memory_refs.sql",
  "050_russian_memory_retrieval.sql",
  "051_r2a_provenance_extraction_foundation.sql",
  "052_r3_verified_profiles.sql",
  "053_r4_r5_claim_consolidation.sql",
  "054_r6_r7_memory_threads.sql",
  "055_memory_reliability_barriers.sql",
  "056_profile_projection_notice_delivery.sql",
  "057_repair_memory_extraction_sequence_ranges.sql",
  "058_scope_eve_turn_identity.sql",
  "059_main_agent_owned_memory.sql",
  "060_memory_thread_creation_attempts.sql",
  "061_private_memory_thread_notices.sql",
] as const;

const POST_V0101_MIGRATIONS = [
  ...MEMORY_RELEASE_MIGRATIONS,
  "062_external_agent_schedule_scopes.sql",
  "063_external_group_agent_schedules.sql",
  "064_turn_bound_memory_subjects.sql",
  "065_eve_032_session_storage_cutover.sql",
  "066_turn_bound_memory_delta_sources.sql",
  "067_durable_memory_review_batches.sql",
  "068_memory_review_recovery.sql",
  "069_memory_review_sandbox_recovery.sql",
  "070_memory_review_agent_collision_recovery.sql",
  "071_chat_communication_preferences.sql",
  "072_memory_review_local_queue_recovery.sql",
  "073_eve_terminal_stream_retention.sql",
  "074_memory_review_empty_response_recovery.sql",
  "075_telegram_channel_senders.sql",
  "076_telegram_hitl_approval_timeout.sql",
  "077_image_generation_operations.sql",
  "078_memory_soft_delete.sql",
  "079_memory_review_source_binding_recovery.sql",
  "080_remove_personal_memory_review_artifacts.sql",
  "081_telegram_progress_notices.sql",
  "082_telegram_chat_reaction_policies.sql",
  "083_remove_group_skill_allowlist.sql",
  "084_idle_memory_review.sql",
  "085_profile_view_attribute.sql",
  "086_authored_skills.sql",
  "087_authored_skill_description_length.sql",
  "088_memory_context_exposures.sql",
  "089_telegram_hitl_batched_approvals.sql",
  "090_timeline_bot_participants.sql",
  "091_memory_review_bot_source_recovery.sql",
  "092_memory_review_bot_source_recovery_session.sql",
  "093_memory_review_bot_source_recovery_token.sql",
  "094_agent_improvement_items.sql",
  "095_authored_skill_loop.sql",
  "096_memory_review_skipped_status.sql",
  "097_memory_review_skipped_terminal.sql",
  "098_memory_review_heal_stuck_lanes.sql",
  "099_owner_health_digests.sql",
  "100_hitl_approval_turn_source.sql",
  "101_shared_tasks.sql",
  "102_life_planning.sql",
  "103_spaces.sql",
  "104_space_record_bindings.sql",
  "105_cascade_scope_cleanup.sql",
  "106_session_space_policy.sql",
  "107_family_space_runtime.sql",
  "108_session_conversation_key_index.sql",
  "109_inherit_space_from_parent.sql",
  "110_inherit_proactive_space.sql",
  "111_workspace_space_partition.sql",
  "112_telegram_chat_audience_proofs.sql",
  "113_unclaimed_tasks.sql",
  "114_private_chat_active_space.sql",
  "115_shopping_lists.sql",
  "116_chat_message_relays.sql",
  "117_shared_task_handover.sql",
  "118_shared_task_recurrence.sql",
  "119_initiative_limits.sql",
  "120_owner_digest_outcome.sql",
  "121_daily_overview_claim.sql",
  "122_personal_time.sql",
  "123_care_areas.sql",
  "124_care_area_title_space.sql",
  "125_family_errands.sql",
  "126_errand_initiative_kind.sql",
  "127_request_followup.sql",
  "128_joint_decisions.sql",
  "129_errand_research.sql",
  "130_errand_result_documents.sql",
  "131_video_budget.sql",
  "132_legacy_operational_quarantine.sql",
  "133_video_space_binding.sql",
  "134_video_completion_queue.sql",
  "135_telegram_message_transport_namespace.sql",
  "136_telegram_group_migrations.sql",
  "137_telegram_retired_group_address.sql",
  "138_conversation_session_rotation_reason.sql",
  "139_model_spend.sql",
  "140_memory_communication_style_attribute.sql",
  "141_session_cleanup_retry.sql",
  "142_workspace_delivery_turn.sql",
  "144_memory_reinforcement_turns.sql",
  "145_coach_initiative.sql",
  "146_coach_touch_claim.sql",
] as const;

const EXPECTED_R0_R7_TABLES = [
  "memory_item_refs",
  "application_conversations",
  "claim_evidence",
  "memory_extraction_batches",
  "profile_subjects",
  "profile_views",
  "external_profile_projection_policies",
  "claim_relations",
  "claim_conflicts",
  "memory_consolidation_jobs",
  "memory_projects",
  "memory_threads",
  "memory_thread_entries",
  "memory_turn_source_sets",
  "memory_turn_sources",
  "memory_review_lanes",
  "memory_review_batches",
  "memory_review_batch_sources",
  "memory_review_owner_alerts",
  "memory_thread_briefs",
  "memory_extraction_retention_holds",
  "memory_extraction_gaps",
  "telegram_final_deliveries",
  "memory_thread_brief_jobs",
  "memory_thread_creation_attempts",
] as const;

function testDatabaseUrlForSchema(): string {
  const value = process.env.DATABASE_URL;
  if (!value || !new URL(value).pathname.endsWith("_test")) {
    throw new Error(
      "AGENT_TEST_DATABASE_UNSAFE: Для upgrade integration-теста нужна отдельная БД *_test",
    );
  }

  // PostgreSQL applies this only to the child connection, keeping every DDL statement out of public.
  const url = new URL(value);
  url.searchParams.set("options", `-c search_path=${TEST_SCHEMA},public`);
  return url.toString();
}

async function runMigrationRunner(): Promise<void> {
  await execFileAsync(
    process.execPath,
    ["--experimental-strip-types", "scripts/migrate.ts"],
    {
      cwd: resolve("."),
      env: { ...process.env, DATABASE_URL: testDatabaseUrlForSchema() },
    },
  );
}

describeWithDatabase("v0.10.1 production ledger upgrade to current memory migrations", () => {
  afterAll(closeDatabase);

  it("applies only the renumbered memory release once and creates the R0-R7 schema", async () => {
    const client = await database().connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      await client.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
      await client.query(`SET search_path TO ${TEST_SCHEMA}, public`);

      // Reconstruct the exact shipped schema and ledger rather than approximating it with fixtures.
      for (const name of V0101_LEDGER) {
        await client.query(await readFile(resolve("migrations", name), "utf8"));
      }
      await client.query(`
        CREATE TABLE schema_migrations (
          name text PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        "INSERT INTO schema_migrations (name) SELECT unnest($1::text[])",
        [[...V0101_LEDGER]],
      );
      await client.query("INSERT INTO families (id, name) VALUES ('00000000-0000-4000-8000-000000000083', 'Legacy skill')");
      await client.query(`
        INSERT INTO telegram_groups
          (family_id, telegram_chat_id, title, type, message_mode, skill_allowlist)
        VALUES
          ('00000000-0000-4000-8000-000000000083', '-100083', 'Legacy skill',
           'external', 'addressed_only', ARRAY['pohuy'])
      `);

      // Filesystem identity is part of the upgrade contract: an old and renamed memory file must not coexist.
      const migrationNames = (await readdir(resolve("migrations")))
        .filter((name) => MIGRATION_FILE_PATTERN.test(name))
        .sort();
      const migrationPurposes = migrationNames.map((name) => name.replace(/^\d{3}_/u, ""));
      expect(new Set(migrationPurposes).size).toBe(migrationPurposes.length);
      expect(migrationNames.filter((name) => name >= "049_" && name < "062_"))
        .toEqual(MEMORY_RELEASE_MIGRATIONS);

      const before = await client.query<{ name: string }>(
        "SELECT name FROM schema_migrations ORDER BY name",
      );
      expect(before.rows.map(({ name }) => name)).toEqual(V0101_LEDGER);
      const namesBefore = new Set(before.rows.map(({ name }) => name));
      expect(migrationNames.filter((name) => !namesBefore.has(name)))
        .toEqual(POST_V0101_MIGRATIONS);

      await runMigrationRunner();

      // The ledger delta proves the real runner skipped all shipped migrations and applied the rest once.
      const after = await client.query<{ name: string }>(
        "SELECT name FROM schema_migrations ORDER BY name",
      );
      expect(after.rows.map(({ name }) => name).filter((name) => !namesBefore.has(name)))
        .toEqual(POST_V0101_MIGRATIONS);
      expect(after.rows).toHaveLength(V0101_LEDGER.length + POST_V0101_MIGRATIONS.length);
      // The real upgrade preserves a legacy group's exact boundary and archives a family with no readers.
      expect((await client.query(
        "SELECT kind,state FROM spaces WHERE family_id='00000000-0000-4000-8000-000000000083' ORDER BY kind",
      )).rows).toEqual([{ kind: "group", state: "active" }, { kind: "legacy_family", state: "archived" }]);
      expect((await client.query(
        `SELECT b.state FROM space_bindings b JOIN spaces s ON s.id=b.space_id
         JOIN telegram_groups g ON g.id=b.group_id
         WHERE g.telegram_chat_id='-100083' AND s.source_group_id=g.id AND s.kind='group'`,
      )).rows).toEqual([{ state: "active" }]);
      await expect(client.query<{ skill_allowlist: string[] }>(
        "SELECT skill_allowlist FROM telegram_groups WHERE telegram_chat_id = '-100083'",
      )).resolves.toMatchObject({ rows: [{ skill_allowlist: [] }] });
      await expect(client.query(
        "UPDATE telegram_groups SET skill_allowlist = ARRAY['removed-skill'] WHERE telegram_chat_id = '-100083'",
      )).rejects.toThrow();

      // Representative authoritative and projection objects prove every R0-R7 migration took effect.
      for (const table of EXPECTED_R0_R7_TABLES) {
        const object = await client.query<{ relation: string | null }>(
          "SELECT to_regclass($1)::text AS relation",
          [`${TEST_SCHEMA}.${table}`],
        );
        expect(object.rows[0]?.relation).not.toBeNull();
      }
      await expect(client.query(
        `SELECT russian_search_vector FROM memory_items LIMIT 0`,
      )).resolves.toBeDefined();
      await expect(client.query(
        `SELECT delivery_status FROM external_profile_projection_notices LIMIT 0`,
      )).resolves.toBeDefined();
      await expect(client.query(
        `SELECT recovery_attempts, last_recovery_diagnostic_code, last_recovered_at
           FROM memory_review_batches LIMIT 0`,
      )).resolves.toBeDefined();
    } finally {
      try {
        await client.query("RESET search_path");
        await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      } finally {
        client.release();
      }
    }
  }, 30_000);
});
