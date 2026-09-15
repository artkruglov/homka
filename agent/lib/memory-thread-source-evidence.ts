/**
 * Model-safe provenance projection for memory-thread entries.
 *
 * Exports:
 * - `MemoryThreadSourceEvidence`: primary claim provenance keyed by opaque entry ref.
 * - `loadMemoryThreadSourceEvidence`: loads live-authorized attribution without database identities.
 */
import type { PoolClient } from "pg";

import { memorySpaceParameters, type MemoryAuthorization } from "./memory-context.js";
import { liveMemoryReadPredicate } from "./memory-live-read-authorization.js";
import type { ModelMemoryEvidence } from "./model-memory.js";

export interface MemoryThreadSourceEvidence extends ModelMemoryEvidence {
  sourceEntryRef: string;
}

export async function loadMemoryThreadSourceEvidence(
  client: Pick<PoolClient, "query">,
  threadId: string,
  auth: MemoryAuthorization,
): Promise<MemoryThreadSourceEvidence[]> {
  const result = await client.query<{
    author_label: string;
    entry_ref: string;
    evidence_kind: ModelMemoryEvidence["kind"];
    observed_at: Date;
  }>(
    `SELECT entry.entry_ref,
            COALESCE(evidence.evidence_kind, 'unresolved') AS evidence_kind,
            COALESCE(evidence.author_label_snapshot, 'Источник не установлен') AS author_label,
            COALESCE(evidence.observed_at, entry.occurred_at) AS observed_at
     FROM memory_thread_entries AS entry
     JOIN memory_threads AS thread ON thread.id = entry.thread_id
     LEFT JOIN LATERAL (
       SELECT evidence_kind, author_label_snapshot, observed_at
       FROM claim_evidence
       WHERE claim_id = entry.source_claim_id AND evidence_role = 'primary'
       ORDER BY observed_at, id LIMIT 1
     ) AS evidence ON true
     WHERE thread.family_id = $1
       AND ${liveMemoryReadPredicate({
         alias: "thread",
         personalIdentityColumn: "scope_partition_key",
         spaceParameters: { id: "$6", version: "$7" },
       })}
       AND entry.thread_id = $5
     ORDER BY entry.entry_ref`,
    [auth.familyId, auth.scopes, auth.userId, auth.groupId, threadId, ...memorySpaceParameters(auth)],
  );
  return result.rows.map((row) => ({
    authorLabel: row.author_label,
    kind: row.evidence_kind,
    observedAt: row.observed_at.toISOString(),
    sourceEntryRef: row.entry_ref,
  }));
}
