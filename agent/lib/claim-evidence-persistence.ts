/**
 * Transaction-local persistence for validated claim evidence.
 *
 * Exports:
 * - `insertClaimEvidence`: inserts verified source rows for a new claim.
 * - `insertClaimReinforcement`: appends verified duplicate evidence.
 */
import type { PoolClient } from "pg";

import type { PreparedClaimEvidence } from "./claim-evidence-writer.js";

export async function insertClaimEvidence(
  client: PoolClient,
  claimId: string,
  prepared: PreparedClaimEvidence,
): Promise<void> {
  // Every source row carries the same claim/conversation trust partition. PostgreSQL composite FKs
  // independently reject cross-zone claim, conversation, author, and timeline references.
  for (const source of prepared.sources) {
    await client.query(
      `INSERT INTO claim_evidence
         (claim_id, family_id, scope, scope_partition_key, evidence_role, evidence_kind,
          origin_conversation_id, origin_conversation_label_snapshot, origin_telegram_group_id,
          author_participant_id, author_user_id, author_label_snapshot, observed_at,
          evidence_snippet, timeline_entry_id, timeline_sequence, source_message_id,
          message_thread_id, source_snapshot)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
               $14, $15, $16, $17, $18, $19)`,
      [claimId, prepared.familyId, prepared.scope, prepared.scopePartitionKey, source.role,
        prepared.evidenceKind, prepared.conversationId, prepared.conversationLabelSnapshot,
        prepared.telegramGroupId, source.authorParticipantId, source.authorUserId,
        source.authorLabelSnapshot, source.observedAt, source.evidenceSnippet,
        source.timelineEntryId, source.timelineSequence, source.sourceMessageId,
        source.messageThreadId, source.sourceSnapshot],
    );
  }
}

export async function insertClaimReinforcement(
  client: PoolClient,
  claimId: string,
  prepared: PreparedClaimEvidence,
): Promise<void> {
  // An exact duplicate adds evidence without inventing a second primary or a second claim.
  for (const source of prepared.sources) {
    await client.query(
      `INSERT INTO claim_evidence
         (claim_id, family_id, scope, scope_partition_key, evidence_role, evidence_kind,
          origin_conversation_id, origin_conversation_label_snapshot, origin_telegram_group_id,
          author_participant_id, author_user_id, author_label_snapshot, observed_at,
          evidence_snippet, timeline_entry_id, timeline_sequence, source_message_id,
          message_thread_id, source_snapshot)
       VALUES ($1, $2, $3, $4, 'reinforcement', $5, $6, $7, $8, $9, $10, $11, $12,
               $13, $14, $15, $16, $17, $18)`,
      [claimId, prepared.familyId, prepared.scope, prepared.scopePartitionKey,
        prepared.evidenceKind, prepared.conversationId, prepared.conversationLabelSnapshot,
        prepared.telegramGroupId, source.authorParticipantId, source.authorUserId,
        source.authorLabelSnapshot, source.observedAt, source.evidenceSnippet,
        source.timelineEntryId, source.timelineSequence, source.sourceMessageId,
        source.messageThreadId, source.sourceSnapshot],
    );
  }
}
