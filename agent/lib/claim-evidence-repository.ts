/**
 * Scoped claim provenance read boundary.
 *
 * Exports:
 * - `ClaimEvidenceItem`: durable source summary with honest timeline availability.
 * - `claimEvidenceRepository`: authorization-filtered evidence lookup by opaque memory ref.
 */
import { database } from "./database.js";
import type { MemoryAuthorization } from "./memory-context.js";

export interface ClaimEvidenceItem {
  authorLabelSnapshot: string | null;
  conversationLabelSnapshot: string;
  evidenceKind: "firsthand" | "inferred" | "reported";
  evidenceSnippet: string;
  fullTimelineEntryAvailable: boolean;
  messageThreadId: string | null;
  observedAt: string;
  role: "primary" | "reinforcement" | "supporting";
  sourceMessageId: string | null;
  timelineSequence: string;
}

export const claimEvidenceRepository = {
  async listByMemoryRef(
    auth: MemoryAuthorization,
    memoryRef: string,
  ): Promise<ClaimEvidenceItem[]> {
    const result = await database().query<{
      author_label_snapshot: string | null;
      evidence_kind: "firsthand" | "inferred" | "reported";
      evidence_role: "primary" | "reinforcement" | "supporting";
      evidence_snippet: string;
      full_timeline_entry_available: boolean;
      message_thread_id: string | null;
      observed_at: Date;
      origin_conversation_label_snapshot: string;
      source_message_id: string | null;
      timeline_sequence: string;
    }>(
      `SELECT evidence.evidence_role, evidence.evidence_kind,
              evidence.origin_conversation_label_snapshot, evidence.author_label_snapshot,
              evidence.observed_at, evidence.evidence_snippet,
              evidence.timeline_entry_id IS NOT NULL AS full_timeline_entry_available,
              evidence.timeline_sequence::text, evidence.source_message_id::text,
              evidence.message_thread_id::text
       FROM memory_item_refs AS ref
       JOIN memory_items AS claim ON claim.id = ref.memory_item_id
       JOIN claim_evidence AS evidence ON evidence.claim_id = claim.id
       WHERE ref.memory_ref = $1 AND claim.family_id = $2
         AND (
           (claim.scope = 'personal' AND 'personal' = ANY($3::memory_scope[])
             AND claim.owner_user_id = $4) OR
           (claim.scope = 'family' AND 'family' = ANY($3::memory_scope[])) OR
           (claim.scope = 'group' AND 'group' = ANY($3::memory_scope[])
             AND claim.group_id = $5)
         )
       ORDER BY CASE evidence.evidence_role
                  WHEN 'primary' THEN 0 WHEN 'supporting' THEN 1 ELSE 2
                END, evidence.observed_at, evidence.id`,
      [memoryRef, auth.familyId, auth.scopes, auth.userId, auth.groupId],
    );
    return result.rows.map((row) => ({
      authorLabelSnapshot: row.author_label_snapshot,
      conversationLabelSnapshot: row.origin_conversation_label_snapshot,
      evidenceKind: row.evidence_kind,
      evidenceSnippet: row.evidence_snippet,
      fullTimelineEntryAvailable: row.full_timeline_entry_available,
      messageThreadId: row.message_thread_id,
      observedAt: row.observed_at.toISOString(),
      role: row.evidence_role,
      sourceMessageId: row.source_message_id,
      timelineSequence: row.timeline_sequence,
    }));
  },
};
