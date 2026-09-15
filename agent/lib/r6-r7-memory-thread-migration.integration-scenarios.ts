/**
 * R6/R7 migration cascade-deletion integration scenario.
 *
 * Exports:
 * - `verifyR6CascadeDeletion`: builds external/family provenance roots, applies R6/R7, and verifies
 *   trust-zone deletion semantics for projects, outcomes, threads, and discovery jobs.
 */
import type { PoolClient } from "pg";
import { expect } from "vitest";

export async function verifyR6CascadeDeletion(
  client: PoolClient,
  migrationSql: string,
): Promise<void> {
  // Both group types share a family owner but retain distinct conversation trust zones.
  const family = await client.query<{ id: string }>(
    "INSERT INTO families (name) VALUES ('R6 cascade') RETURNING id",
  );
  const user = await client.query<{ id: string }>(
    "INSERT INTO users (telegram_user_id, display_name) VALUES ('r6-cascade-owner', 'Owner') RETURNING id",
  );
  await client.query(
    "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')",
    [family.rows[0]!.id, user.rows[0]!.id],
  );
  const groups = await client.query<{ id: string; type: string }>(
    `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode)
     VALUES ($1, '-100-r6-external', 'External R6', 'external', 'addressed_only'),
            ($1, '-100-r6-family', 'Family R6', 'family_private', 'addressed_only')
     RETURNING id, type::text`,
    [family.rows[0]!.id],
  );
  const externalGroup = groups.rows.find((row) => row.type === "external")!;
  const familyGroup = groups.rows.find((row) => row.type === "family_private")!;
  const conversations = await client.query<{
    id: string;
    scope: string;
    telegram_group_id: string;
  }>(
    `SELECT id, scope::text, telegram_group_id FROM application_conversations
     WHERE telegram_group_id = ANY($1::uuid[])`,
    [groups.rows.map((row) => row.id)],
  );
  const externalConversation = conversations.rows.find(
    (row) => row.telegram_group_id === externalGroup.id,
  )!;
  const familyConversation = conversations.rows.find(
    (row) => row.telegram_group_id === familyGroup.id,
  )!;

  // Each source has a durable participant, timeline row, evidenced claim, and exact trust partition.
  const source = async (input: {
    conversationId: string;
    groupId: string;
    operationKey: string;
    scope: "family" | "group";
    sequence: number;
  }) => {
    const participant = await client.query<{ id: string }>(
      `INSERT INTO conversation_participants
         (conversation_id, family_id, scope, scope_partition_key, telegram_user_id,
          linked_user_id, display_name_snapshot, first_observed_at, last_observed_at)
       VALUES ($1, $2, $3, $4, 'r6-cascade-owner', $5, 'Owner', now(), now()) RETURNING id`,
      [input.conversationId, family.rows[0]!.id, input.scope,
        input.scope === "group" ? input.groupId : family.rows[0]!.id, user.rows[0]!.id],
    );
    const timeline = await client.query<{ id: string }>(
      `INSERT INTO telegram_group_messages
         (conversation_id, group_id, telegram_message_id, sequence_id, actor_kind, actor_id,
          telegram_user_id, sender_display_name, sender_is_bot, message_kind, content_text, sent_at)
       VALUES ($1, $2, $3, $4, 'user', 'telegram:r6-cascade-owner', 'r6-cascade-owner',
               'Owner', false, 'text', $5, now()) RETURNING id`,
      [input.conversationId, input.groupId, 9000 + input.sequence, input.sequence,
        `${input.scope} durable source`],
    );
    const claim = await client.query<{ id: string }>(
      `INSERT INTO memory_items
         (family_id, group_id, author_user_id, author_telegram_user_id, scope, kind, content,
          source, confirmation, sensitivity, operation_key, provenance_state,
          origin_conversation_id, save_approved, content_normalized, profile_eligible)
       VALUES ($1, CASE WHEN $2::memory_scope = 'group' THEN $3::uuid ELSE NULL END,
               $4, CASE WHEN $2::memory_scope = 'group' THEN 'r6-cascade-owner' ELSE NULL END,
               $2, 'episode', $5, 'test:r6-cascade', 'user_confirmed', 'normal', $6,
               'evidenced', $7, true, lower($5), false) RETURNING id`,
      [family.rows[0]!.id, input.scope, input.groupId, user.rows[0]!.id,
        `${input.scope} durable claim`, input.operationKey, input.conversationId],
    );
    await client.query(
      `INSERT INTO claim_evidence
         (claim_id, family_id, scope, scope_partition_key, evidence_role, evidence_kind,
          origin_conversation_id, origin_conversation_label_snapshot, origin_telegram_group_id,
          author_participant_id, author_user_id, observed_at, evidence_snippet,
          timeline_entry_id, timeline_sequence, source_message_id, source_snapshot)
       VALUES ($1, $2, $3, $4, 'primary', 'firsthand', $5, $6, $7, $8, $9, now(),
               $10, $11, $12, $13, '{}'::jsonb)`,
      [claim.rows[0]!.id, family.rows[0]!.id, input.scope,
        input.scope === "group" ? input.groupId : family.rows[0]!.id,
        input.conversationId, `${input.scope} origin`, input.groupId,
        participant.rows[0]!.id, user.rows[0]!.id, `${input.scope} durable source`,
        timeline.rows[0]!.id, input.sequence, 9000 + input.sequence],
    );
    return { claimId: claim.rows[0]!.id, timelineId: timeline.rows[0]!.id };
  };
  const externalSource = await source({
    conversationId: externalConversation.id,
    groupId: externalGroup.id,
    operationKey: "r6-external-cascade-claim",
    scope: "group",
    sequence: 1,
  });
  const familySource = await source({
    conversationId: familyConversation.id,
    groupId: familyGroup.id,
    operationKey: "r6-family-cascade-claim",
    scope: "family",
    sequence: 1,
  });

  await client.query(migrationSql);
  const event = await client.query<{ id: string }>(
    `INSERT INTO audit_events (family_id, actor_user_id, event_type)
     VALUES ($1, $2, 'r6.cascade') RETURNING id`,
    [family.rows[0]!.id, user.rows[0]!.id],
  );

  // Build the complete R6 root graph for one scope without sharing cross-zone identifiers.
  const createR6Roots = async (input: {
    claimId: string;
    conversationId: string;
    groupId: string | null;
    scope: "family" | "group";
    timelineId: string;
  }) => {
    const partition = input.scope === "group" ? input.groupId! : family.rows[0]!.id;
    const project = await client.query<{ id: string }>(
      `INSERT INTO memory_projects (family_id, group_id, scope, scope_partition_key, title)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [family.rows[0]!.id, input.groupId, input.scope, partition, `${input.scope} project`],
    );
    await client.query("UPDATE memory_items SET memory_project_id = $2 WHERE id = $1", [
      input.claimId,
      project.rows[0]!.id,
    ]);
    const outcome = await client.query<{ id: string }>(
      `INSERT INTO confirmed_outcomes
         (family_id, scope, scope_partition_key, memory_project_id, authority,
          application_event_id, source_conversation_id, source_timeline_entry_id,
          source_snapshot, summary, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '{}'::jsonb, $9, now()) RETURNING id`,
      [family.rows[0]!.id, input.scope, partition, project.rows[0]!.id,
        input.scope === "family" ? "verified_user_statement" : "application_event",
        event.rows[0]!.id, input.scope === "family" ? input.conversationId : null,
        input.scope === "family" ? input.timelineId : null, `${input.scope} outcome`],
    );
    await client.query(
      `INSERT INTO confirmed_outcome_source_claims
         (outcome_id, source_claim_id, family_id, scope, scope_partition_key, source_role)
       VALUES ($1, $2, $3, $4, $5, 'result')`,
      [outcome.rows[0]!.id, input.claimId, family.rows[0]!.id, input.scope, partition],
    );
    const thread = await client.query<{ id: string }>(
      `INSERT INTO memory_threads
         (family_id, scope, scope_partition_key, memory_project_id, title, purpose,
          status, completion_outcome_id, completed_at)
       VALUES ($1, $2, $3, $4, $5, 'Cascade contract', 'completed', $6, now()) RETURNING id`,
      [family.rows[0]!.id, input.scope, partition, project.rows[0]!.id,
        `${input.scope} thread`, outcome.rows[0]!.id],
    );
    await client.query(
      `INSERT INTO memory_thread_entries
         (thread_id, family_id, scope, scope_partition_key, source_claim_id, role, occurred_at)
       VALUES ($1, $2, $3, $4, $5, 'goal', now())`,
      [thread.rows[0]!.id, family.rows[0]!.id, input.scope, partition, input.claimId],
    );
    const job = await client.query<{ id: string }>(
      `INSERT INTO memory_thread_discovery_jobs
         (family_id, scope, scope_partition_key, memory_project_id, discovery_path,
          candidate_key, input_hash)
       VALUES ($1, $2, $3, $4, 'online', $5, $6) RETURNING id`,
      [family.rows[0]!.id, input.scope, partition, project.rows[0]!.id,
        input.scope === "group" ? "a".repeat(64) : "b".repeat(64),
        input.scope === "group" ? "c".repeat(64) : "d".repeat(64)],
    );
    return {
      jobId: job.rows[0]!.id,
      outcomeId: outcome.rows[0]!.id,
      projectId: project.rows[0]!.id,
      threadId: thread.rows[0]!.id,
    };
  };
  const externalRoots = await createR6Roots({
    claimId: externalSource.claimId,
    conversationId: externalConversation.id,
    groupId: externalGroup.id,
    scope: "group",
    timelineId: externalSource.timelineId,
  });
  const familyRoots = await createR6Roots({
    claimId: familySource.claimId,
    conversationId: familyConversation.id,
    groupId: null,
    scope: "family",
    timelineId: familySource.timelineId,
  });

  // External deletion cascades every group-owned R6 root.
  await expect(client.query("DELETE FROM telegram_groups WHERE id = $1", [externalGroup.id]))
    .resolves.toBeDefined();
  await expect(client.query(
    `SELECT
       (SELECT count(*)::integer FROM memory_projects WHERE id = $1) AS projects,
       (SELECT count(*)::integer FROM confirmed_outcomes WHERE id = $2) AS outcomes,
       (SELECT count(*)::integer FROM memory_threads WHERE id = $3) AS threads,
       (SELECT count(*)::integer FROM memory_thread_discovery_jobs WHERE id = $4) AS jobs`,
    [externalRoots.projectId, externalRoots.outcomeId, externalRoots.threadId, externalRoots.jobId],
  )).resolves.toMatchObject({ rows: [{ jobs: 0, outcomes: 0, projects: 0, threads: 0 }] });

  // Family roots survive group deletion, while erased conversation provenance retracts the outcome.
  await expect(client.query("DELETE FROM telegram_groups WHERE id = $1", [familyGroup.id]))
    .resolves.toBeDefined();
  await expect(client.query(
    `SELECT outcome.status::text, outcome.source_conversation_id, outcome.source_timeline_entry_id,
            outcome.source_erased_at, thread.status::text AS thread_status,
            thread.completion_outcome_id,
            EXISTS (SELECT 1 FROM memory_projects WHERE id = $3) AS project_survives,
            EXISTS (SELECT 1 FROM memory_thread_discovery_jobs WHERE id = $4) AS job_survives
     FROM confirmed_outcomes AS outcome
     JOIN memory_threads AS thread ON thread.id = $2
     WHERE outcome.id = $1`,
    [familyRoots.outcomeId, familyRoots.threadId, familyRoots.projectId, familyRoots.jobId],
  )).resolves.toMatchObject({
    rows: [{
      completion_outcome_id: null,
      job_survives: true,
      project_survives: true,
      source_conversation_id: null,
      source_erased_at: expect.any(Date),
      source_timeline_entry_id: null,
      status: "retracted",
      thread_status: "active",
    }],
  });
}
