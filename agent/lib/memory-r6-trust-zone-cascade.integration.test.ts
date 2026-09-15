/**
 * Complete R6 trust-zone cascade integration tests.
 *
 * Constructs covered:
 * - External group deletion removes every project/outcome/thread/discovery descendant.
 * - Family group deletion preserves family roots while erasing source coordinates, retracting the
 *   completion projection, invalidating its brief, and retaining scoped audit/lifecycle rows.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { closeDatabase, database } from "./database.js";
import { MEMORY_EMBEDDING_DIMENSIONS } from "./memory-config.js";
import { createMemoryThreadBriefRepository } from "./memory-thread-brief-repository.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;

interface ZoneFixture {
  briefId: string;
  claimId: string;
  conversationId: string;
  groupId: string;
  jobId: string;
  outcomeId: string;
  projectId: string;
  threadId: string;
}

async function createZone(input: {
  familyId: string;
  scope: "family" | "group";
  suffix: string;
  userId: string;
}): Promise<ZoneFixture> {
  const group = await database().query<{ id: string }>(
    `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode)
     VALUES ($1, $2, $3, $4, 'addressed_only') RETURNING id`,
    [input.familyId, `-100-r6-all-${input.suffix}`, `${input.scope} all R6`,
      input.scope === "group" ? "external" : "family_private"],
  );
  const conversation = await database().query<{ id: string }>(
    "SELECT id FROM application_conversations WHERE telegram_group_id = $1",
    [group.rows[0]!.id],
  );
  const partition = input.scope === "group" ? group.rows[0]!.id : input.familyId;
  const participant = await database().query<{ id: string }>(
    `INSERT INTO conversation_participants
       (conversation_id, family_id, scope, scope_partition_key, telegram_user_id,
        linked_user_id, display_name_snapshot, first_observed_at, last_observed_at)
     VALUES ($1, $2, $3, $4, 'r6-all-owner', $5, 'Owner', now(), now()) RETURNING id`,
    [conversation.rows[0]!.id, input.familyId, input.scope, partition, input.userId],
  );
  const timeline = await database().query<{ id: string }>(
    `INSERT INTO telegram_group_messages
       (conversation_id, group_id, telegram_message_id, sequence_id, actor_kind, actor_id,
        telegram_user_id, sender_display_name, sender_is_bot, message_kind, content_text, sent_at)
     VALUES ($1, $2, $3, 1, 'user', 'telegram:r6-all-owner', 'r6-all-owner', 'Owner', false,
             'text', $4, now()) RETURNING id`,
    [conversation.rows[0]!.id, group.rows[0]!.id,
      input.scope === "group" ? 8101 : 8102, `${input.scope} source`],
  );
  await database().query(
    `INSERT INTO telegram_group_message_ids(conversation_id,group_id,telegram_message_id,entry_id)
     VALUES($1,$2,$3,$4)`,
    [conversation.rows[0]!.id, group.rows[0]!.id, input.scope === "group" ? 8101 : 8102, timeline.rows[0]!.id],
  );
  const project = await database().query<{ id: string }>(
    `INSERT INTO memory_projects (family_id, group_id, scope, scope_partition_key, title)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [input.familyId, input.scope === "group" ? group.rows[0]!.id : null,
      input.scope, partition, `${input.scope} complete project`],
  );
  const claim = await database().query<{ id: string }>(
    `INSERT INTO memory_items
       (family_id, group_id, author_user_id, author_telegram_user_id, scope, kind, content,
        source, confirmation, sensitivity, operation_key, provenance_state,
        origin_conversation_id, memory_project_id, save_approved, content_normalized,
        profile_eligible)
     VALUES ($1, $2, $3, $4, $5, 'episode', $6, 'test:r6-all', 'user_confirmed', 'normal',
             $7, 'evidenced', $8, $9, true, lower($6), false) RETURNING id`,
    [input.familyId, input.scope === "group" ? group.rows[0]!.id : null, input.userId,
      input.scope === "group" ? "r6-all-owner" : null, input.scope, `${input.scope} claim`,
      `r6-all-claim-${input.suffix}`, conversation.rows[0]!.id, project.rows[0]!.id],
  );
  await database().query(
    `INSERT INTO claim_evidence
       (claim_id, family_id, scope, scope_partition_key, evidence_role, evidence_kind,
        origin_conversation_id, origin_conversation_label_snapshot, origin_telegram_group_id,
        author_participant_id, author_user_id, observed_at, evidence_snippet,
        timeline_entry_id, timeline_sequence, source_message_id, source_snapshot)
     VALUES ($1, $2, $3, $4, 'primary', 'firsthand', $5, $6, $7, $8, $9, now(), $10,
             $11, 1, $12, '{}'::jsonb)`,
    [claim.rows[0]!.id, input.familyId, input.scope, partition, conversation.rows[0]!.id,
      `${input.scope} origin`, group.rows[0]!.id, participant.rows[0]!.id, input.userId,
      `${input.scope} source`, timeline.rows[0]!.id, input.scope === "group" ? 8101 : 8102],
  );
  const event = await database().query<{ id: string }>(
    `INSERT INTO audit_events (family_id, actor_user_id, event_type)
     VALUES ($1, $2, $3) RETURNING id`,
    [input.familyId, input.userId, `r6.${input.suffix}.confirmed`],
  );
  const outcome = await database().query<{ id: string }>(
    `INSERT INTO confirmed_outcomes
       (family_id, scope, scope_partition_key, memory_project_id, outcome_kind, authority,
        application_event_id, source_conversation_id, source_timeline_entry_id,
        source_snapshot, summary, occurred_at)
     VALUES ($1, $2, $3, $4, 'completion_episode', $5, $6, $7, $8, '{}'::jsonb, $9, now())
     RETURNING id`,
    [input.familyId, input.scope, partition, project.rows[0]!.id,
      input.scope === "family" ? "verified_user_statement" : "application_event",
      event.rows[0]!.id, input.scope === "family" ? conversation.rows[0]!.id : null,
      input.scope === "family" ? timeline.rows[0]!.id : null, `${input.scope} outcome`],
  );
  await database().query(
    `INSERT INTO confirmed_outcome_source_claims
       (outcome_id, source_claim_id, family_id, scope, scope_partition_key, source_role)
     VALUES ($1, $2, $3, $4, $5, 'result')`,
    [outcome.rows[0]!.id, claim.rows[0]!.id, input.familyId, input.scope, partition],
  );
  await database().query(
    `INSERT INTO confirmed_outcome_operations
       (family_id, operation_key, input_hash, action, outcome_id)
     VALUES ($1, $2, repeat('a', 64), 'create', $3)`,
    [input.familyId, `r6-all-outcome-${input.suffix}`, outcome.rows[0]!.id],
  );
  const thread = await database().query<{ id: string }>(
    `INSERT INTO memory_threads
       (family_id, scope, scope_partition_key, memory_project_id, title, purpose,
        status, completion_outcome_id, completed_at)
     VALUES ($1, $2, $3, $4, $5, 'Complete cascade', 'completed', $6, now()) RETURNING id`,
    [input.familyId, input.scope, partition, project.rows[0]!.id,
      `${input.scope} complete thread`, outcome.rows[0]!.id],
  );
  const entries = await database().query<{ id: string; source: string }>(
    `INSERT INTO memory_thread_entries
       (thread_id, family_id, scope, scope_partition_key, source_claim_id,
        source_outcome_id, role, occurred_at)
     VALUES ($1, $2, $3, $4, $5, NULL, 'goal', now()),
            ($1, $2, $3, $4, NULL, $6, 'outcome', now())
     RETURNING id, CASE WHEN source_claim_id IS NULL THEN 'outcome' ELSE 'claim' END AS source`,
    [thread.rows[0]!.id, input.familyId, input.scope, partition,
      claim.rows[0]!.id, outcome.rows[0]!.id],
  );
  const claimEntry = entries.rows.find((row) => row.source === "claim")!;
  const brief = await database().query<{ id: string }>(
    `INSERT INTO memory_thread_briefs
       (thread_id, generation, model_version, schema_version, total_characters, item_count)
     SELECT id, generation, 'r6-all-model', 'r6-all-schema', 10, 1
     FROM memory_threads WHERE id = $1 RETURNING id`,
    [thread.rows[0]!.id],
  );
  await database().query(
    `INSERT INTO memory_thread_brief_blocks (brief_id, thread_id, ordinal, kind, content)
     VALUES ($1, $2, 0, 'active_goals_open_loops', 'Source goal')`,
    [brief.rows[0]!.id, thread.rows[0]!.id],
  );
  await database().query(
    `INSERT INTO memory_thread_brief_block_sources
       (brief_id, block_ordinal, thread_id, thread_entry_id)
     VALUES ($1, 0, $2, $3)`,
    [brief.rows[0]!.id, thread.rows[0]!.id, claimEntry.id],
  );
  await database().query(
    `INSERT INTO memory_thread_creation_notices
       (thread_id, family_id, status, origin_conversation_id, delivery_started_at,
        delivery_diagnostic_code)
     VALUES ($1, $2, 'failed', $3, now(), 'AGENT_MEMORY_THREAD_NOTICE_PRIVATE_ONLY')`,
    [thread.rows[0]!.id, input.familyId, conversation.rows[0]!.id],
  );
  const job = await database().query<{ id: string }>(
    `INSERT INTO memory_thread_discovery_jobs
       (family_id, scope, scope_partition_key, memory_project_id, discovery_path,
        candidate_key, input_hash)
     VALUES ($1, $2, $3, $4, 'online', $5, $6) RETURNING id`,
    [input.familyId, input.scope, partition, project.rows[0]!.id,
      input.scope === "group" ? "1".repeat(64) : "2".repeat(64),
      input.scope === "group" ? "3".repeat(64) : "4".repeat(64)],
  );
  await database().query(
    `INSERT INTO memory_thread_discovery_sources
       (job_id, source_claim_id, family_id, scope, scope_partition_key)
     VALUES ($1, $2, $3, $4, $5)`,
    [job.rows[0]!.id, claim.rows[0]!.id, input.familyId, input.scope, partition],
  );
  await database().query(
    `INSERT INTO memory_thread_discovery_existing
       (job_id, thread_candidate_ref, thread_id, is_parent_candidate)
     VALUES ($1, 'thread_11111111111111111111111111111111', $2, true)`,
    [job.rows[0]!.id, thread.rows[0]!.id],
  );
  await database().query(
    `INSERT INTO memory_thread_discovery_claim_coverage (source_claim_id, last_job_id)
     VALUES ($1, $2)`,
    [claim.rows[0]!.id, job.rows[0]!.id],
  );
  await database().query(
    `INSERT INTO memory_thread_lifecycle_operations
       (family_id, operation_key, input_hash, thread_id, action, outcome_id)
     VALUES ($1, $2, repeat('b', 64), $3, 'complete', $4)`,
    [input.familyId, `r6-all-lifecycle-${input.suffix}`, thread.rows[0]!.id, outcome.rows[0]!.id],
  );
  return {
    briefId: brief.rows[0]!.id,
    claimId: claim.rows[0]!.id,
    conversationId: conversation.rows[0]!.id,
    groupId: group.rows[0]!.id,
    jobId: job.rows[0]!.id,
    outcomeId: outcome.rows[0]!.id,
    projectId: project.rows[0]!.id,
    threadId: thread.rows[0]!.id,
  };
}

describeWithDatabase("complete R6 trust-zone cascade", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE users, families CASCADE");
  });

  afterAll(closeDatabase);

  it("erases a family after restore recreates conversation cascades after composite checks", async () => {
    const familyId = (await database().query("INSERT INTO families(name) VALUES('Restored family') RETURNING id")).rows[0].id;
    const userId = (await database().query("INSERT INTO users(telegram_user_id,display_name) VALUES('r6-all-owner','Owner') RETURNING id")).rows[0].id;
    await database().query("INSERT INTO family_memberships(family_id,user_id,role) VALUES($1,$2,'owner')", [familyId,userId]);
    await createZone({ familyId, userId, scope: "group", suffix: "restored" });
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      // A restored schema may visit conversations before groups when erasing the family.
      await client.query(`ALTER TABLE telegram_groups DROP CONSTRAINT telegram_groups_family_id_fkey,
        ADD CONSTRAINT telegram_groups_family_id_fkey FOREIGN KEY(family_id)
        REFERENCES families(id) ON DELETE CASCADE`);
      // pg_restore can create these FKs after the redundant conversation/group integrity FKs.
      // No semantic rule changes: only the creation order of the same cascade is different.
      for (const table of ["telegram_group_messages", "telegram_group_message_ids"] as const) {
        await client.query(`ALTER TABLE ${table} DROP CONSTRAINT ${table}_conversation_id_fkey,
          ADD CONSTRAINT ${table}_conversation_id_fkey FOREIGN KEY(conversation_id)
          REFERENCES application_conversations(id) ON DELETE CASCADE`);
      }
      await client.query("DELETE FROM families WHERE id=$1", [familyId]);
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      expect((await client.query("SELECT id FROM application_conversations WHERE family_id=$1", [familyId])).rowCount).toBe(0);
      expect((await client.query("SELECT 1 FROM telegram_group_message_ids")).rowCount).toBe(0);
    } finally { await client.query("ROLLBACK"); client.release(); }
  });

  it.each(["family", "group"] as const)("can erase a family with complete %s memory descendants", async (scope) => {
    const familyId = (await database().query("INSERT INTO families(name) VALUES('Cascade family') RETURNING id")).rows[0].id;
    const userId = (await database().query("INSERT INTO users(telegram_user_id,display_name) VALUES('r6-all-owner','Owner') RETURNING id")).rows[0].id;
    await database().query("INSERT INTO family_memberships(family_id,user_id,role) VALUES($1,$2,'owner')", [familyId,userId]);
    const zone = await createZone({ familyId, userId, scope, suffix: `erase-${scope}` });
    await database().query("DELETE FROM families WHERE id=$1", [familyId]);
    for (const [table, id] of [["memory_threads",zone.threadId], ["memory_items_all",zone.claimId],
      ["confirmed_outcomes",zone.outcomeId], ["memory_projects",zone.projectId],
      ["memory_thread_briefs",zone.briefId]] as const) {
      expect((await database().query(`SELECT id FROM ${table} WHERE id=$1`, [id])).rowCount).toBe(0);
    }
    expect((await database().query("SELECT id FROM users WHERE id=$1", [userId])).rowCount).toBe(1);
  });

  it("cascades external descendants and safely retires family completion descendants", async () => {
    const family = await database().query<{ id: string }>(
      "INSERT INTO families (name) VALUES ('All R6 cascade') RETURNING id",
    );
    const user = await database().query<{ id: string }>(
      "INSERT INTO users (telegram_user_id, display_name) VALUES ('r6-all-owner', 'Owner') RETURNING id",
    );
    await database().query(
      "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')",
      [family.rows[0]!.id, user.rows[0]!.id],
    );
    const external = await createZone({
      familyId: family.rows[0]!.id,
      scope: "group",
      suffix: "external",
      userId: user.rows[0]!.id,
    });
    const familyZone = await createZone({
      familyId: family.rows[0]!.id,
      scope: "family",
      suffix: "family",
      userId: user.rows[0]!.id,
    });

    await database().query("DELETE FROM telegram_groups WHERE id = $1", [external.groupId]);
    await expect(database().query(
      `SELECT
         EXISTS (SELECT 1 FROM memory_projects WHERE id = $1) AS project,
         EXISTS (SELECT 1 FROM confirmed_outcomes WHERE id = $2) AS outcome,
         EXISTS (SELECT 1 FROM memory_threads WHERE id = $3) AS thread,
         EXISTS (SELECT 1 FROM memory_thread_briefs WHERE id = $4) AS brief,
         EXISTS (SELECT 1 FROM memory_thread_discovery_jobs WHERE id = $5) AS job,
         EXISTS (SELECT 1 FROM memory_items WHERE id = $6) AS claim,
         (SELECT count(*)::integer FROM confirmed_outcome_source_claims
          WHERE outcome_id = $2) AS outcome_sources,
         (SELECT count(*)::integer FROM confirmed_outcome_operations
          WHERE outcome_id = $2) AS outcome_operations,
         (SELECT count(*)::integer FROM memory_thread_entries
          WHERE thread_id = $3) AS thread_entries,
         (SELECT count(*)::integer FROM memory_thread_brief_blocks
          WHERE brief_id = $4) AS brief_blocks,
         (SELECT count(*)::integer FROM memory_thread_brief_block_sources
          WHERE brief_id = $4) AS brief_block_sources,
         (SELECT count(*)::integer FROM memory_thread_creation_notices
          WHERE thread_id = $3) AS creation_notices,
         (SELECT count(*)::integer FROM memory_thread_discovery_sources
          WHERE job_id = $5) AS discovery_sources,
         (SELECT count(*)::integer FROM memory_thread_discovery_existing
          WHERE job_id = $5) AS discovery_existing,
         (SELECT count(*)::integer FROM memory_thread_discovery_claim_coverage
          WHERE source_claim_id = $6) AS discovery_coverage,
         (SELECT count(*)::integer FROM memory_thread_lifecycle_operations
          WHERE thread_id = $3) AS lifecycle_operations`,
      [external.projectId, external.outcomeId, external.threadId, external.briefId,
        external.jobId, external.claimId],
    )).resolves.toMatchObject({
      rows: [{
        brief: false,
        brief_block_sources: 0,
        brief_blocks: 0,
        claim: false,
        creation_notices: 0,
        discovery_coverage: 0,
        discovery_existing: 0,
        discovery_sources: 0,
        job: false,
        lifecycle_operations: 0,
        outcome: false,
        outcome_operations: 0,
        outcome_sources: 0,
        project: false,
        thread: false,
        thread_entries: 0,
      }],
    });

    await database().query("DELETE FROM telegram_groups WHERE id = $1", [familyZone.groupId]);
    await expect(database().query(
      `SELECT outcome.status::text, outcome.source_conversation_id, outcome.source_erased_at,
              thread.status::text AS thread_status, thread.completion_outcome_id,
              claim.provenance_state::text,
              EXISTS (SELECT 1 FROM memory_thread_briefs WHERE id = $4) AS brief_survives,
              EXISTS (SELECT 1 FROM memory_thread_discovery_jobs WHERE id = $5) AS job_survives,
              EXISTS (SELECT 1 FROM memory_projects WHERE id = $6) AS project_survives,
               (SELECT count(*)::integer FROM memory_thread_entries
                WHERE thread_id = thread.id AND source_outcome_id IS NOT NULL) AS outcome_entries,
               (SELECT count(*)::integer FROM memory_thread_entries
                WHERE thread_id = thread.id AND source_claim_id IS NOT NULL) AS claim_entries,
               (SELECT count(*)::integer FROM confirmed_outcome_source_claims
                WHERE outcome_id = outcome.id) AS outcome_sources,
               (SELECT count(*)::integer FROM confirmed_outcome_operations
                WHERE outcome_id = outcome.id) AS outcome_operations,
               (SELECT count(*)::integer FROM memory_thread_brief_blocks
                WHERE brief_id = $4) AS brief_blocks,
               (SELECT count(*)::integer FROM memory_thread_brief_block_sources
                WHERE brief_id = $4) AS brief_block_sources,
               (SELECT count(*)::integer FROM memory_thread_creation_notices
                WHERE thread_id = thread.id) AS creation_notices,
               (SELECT count(*)::integer FROM memory_thread_discovery_sources
                WHERE job_id = $5) AS discovery_sources,
               (SELECT count(*)::integer FROM memory_thread_discovery_existing
                WHERE job_id = $5) AS discovery_existing,
               (SELECT count(*)::integer FROM memory_thread_discovery_claim_coverage
                WHERE source_claim_id = claim.id) AS discovery_coverage,
               (SELECT count(*)::integer FROM memory_thread_lifecycle_operations
                WHERE thread_id = thread.id) AS lifecycle_operations
       FROM confirmed_outcomes AS outcome
       JOIN memory_threads AS thread ON thread.id = $2
       JOIN memory_items AS claim ON claim.id = $3
       WHERE outcome.id = $1`,
      [familyZone.outcomeId, familyZone.threadId, familyZone.claimId, familyZone.briefId,
        familyZone.jobId, familyZone.projectId],
    )).resolves.toMatchObject({
      rows: [{
        brief_block_sources: 0,
        brief_blocks: 0,
        brief_survives: false,
        claim_entries: 0,
        completion_outcome_id: null,
        creation_notices: 0,
        discovery_coverage: 1,
        discovery_existing: 1,
        discovery_sources: 1,
        job_survives: true,
        lifecycle_operations: 1,
        outcome_entries: 0,
        outcome_operations: 1,
        outcome_sources: 1,
        project_survives: true,
        provenance_state: "legacy_unresolved",
        source_conversation_id: null,
        source_erased_at: expect.any(Date),
        status: "retracted",
        thread_status: "active",
      }],
    });

    // Erased provenance may remain as family audit history, but must never regenerate model context.
    const briefs = createMemoryThreadBriefRepository();
    await expect(briefs.activate({
      auth: {
        familyId: family.rows[0]!.id,
        groupId: null,
        role: "owner",
        scopes: ["family"],
        telegramActorId: "r6-all-owner",
        telegramActorKind: "telegram_user",
        telegramUserId: "r6-all-owner",
        userId: user.rows[0]!.id,
      },
      queryEmbedding: Array<number>(MEMORY_EMBEDDING_DIMENSIONS).fill(0),
      retrievedClaimIds: [familyZone.claimId],
      skillHints: [],
    })).resolves.toEqual({ threads: [], totalCharacters: 0 });
  });
});
