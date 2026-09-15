/**
 * Slot-based claim versioning.
 *
 * Exports:
 * - `SlotIdentity`: one subject slot in one partition, space and memory project.
 * - `lockSlot`: serializes writers of one slot before the new claim is inserted.
 * - `supersedeSlotClaims`: retires older active claims of the same subject and attribute slot.
 */
import type { PoolClient } from "pg";
import { MEMORY_SEMANTIC_KINDS } from "./memory-config.js";

import type { MemoryAuthorization, MemoryScope } from "./memory-context.js";
import { resolveClaimPartition } from "./memory-claim-partition.js";
import type { MemoryKind } from "./memory-record.js";

export interface SlotIdentity {
  attribute: string;
  kind: MemoryKind;
  /** A project-bound claim lives in its project's slot, never in the unbound one. */
  memoryProjectId: string | null;
  scope: MemoryScope;
  scopePartitionKey: string;
  subjectLabel: string | null;
  subjectParticipantId: string | null;
  subjectUserId: string | null;
}

export interface SlotSupersedeInput extends SlotIdentity {
  newClaimId: string;
  systemActor: boolean;
}

// Semantic kinds share a slot (a "fact" and a "family_shared" about the same thing are one
// version chain); an episode slot only ever holds episodes.
function slotKinds(kind: MemoryKind): string[] {
  return kind === "episode" ? ["episode"] : [...MEMORY_SEMANTIC_KINDS];
}

/**
 * Held to commit, taken before the new claim is inserted. Row locks cannot see a concurrent first
 * write into an empty slot; today the scope quota lock happens to serialize such writers too, but
 * slot correctness must not depend on that (upstream 960c4b9).
 */
export async function lockSlot(client: PoolClient, auth: MemoryAuthorization, slot: SlotIdentity): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [JSON.stringify([
    "memory-slot", auth.familyId, slot.scope, slot.scopePartitionKey,
    resolveClaimPartition(auth, slot.scope).spaceId, slot.memoryProjectId, slot.attribute,
    slot.kind === "episode" ? "episode" : "semantic", slot.subjectLabel,
    slot.subjectParticipantId, slot.subjectUserId,
  ])]);
}

export async function supersedeSlotClaims(
  client: PoolClient,
  auth: MemoryAuthorization,
  input: SlotSupersedeInput,
): Promise<string[]> {
  // The slot is one subject in one partition; a label-only subject is still one slot per label.
  // The identity filters mirror exact reinforcement, memory project and family subject included:
  // a project-bound claim must never retire a claim of another project or of no project.
  const previous = await client.query<{ id: string }>(
    `SELECT item.id FROM memory_items AS item
      WHERE item.family_id = $1 AND item.scope = $2 AND item.scope_partition_key = $3
        AND item.claim_status = 'active' AND item.id <> $4
        AND item.attribute = $5 AND item.kind = ANY($6::memory_kind[])
        AND item.subject_participant_id IS NOT DISTINCT FROM $7::uuid
        AND item.subject_user_id IS NOT DISTINCT FROM $8::uuid
        AND item.subject_family_id IS NULL
        AND item.subject_label IS NOT DISTINCT FROM $9::text
        AND item.space_id IS NOT DISTINCT FROM $10::uuid
        AND item.memory_project_id IS NOT DISTINCT FROM $11::uuid
      ORDER BY item.created_at, item.id FOR UPDATE OF item`,
    [auth.familyId, input.scope, input.scopePartitionKey, input.newClaimId, input.attribute,
      slotKinds(input.kind), input.subjectParticipantId, input.subjectUserId, input.subjectLabel,
      resolveClaimPartition(auth, input.scope).spaceId, input.memoryProjectId],
  );
  const ids = previous.rows.map((row) => row.id);
  for (const previousId of ids) {
    // Thread order follows the newest version, exactly as an explicit correction does.
    await client.query(
      `INSERT INTO memory_thread_entries
         (thread_id, family_id, scope, scope_partition_key, source_claim_id, role, occurred_at)
       SELECT thread_id, family_id, scope, scope_partition_key, $2, role, occurred_at
         FROM memory_thread_entries WHERE source_claim_id = $1
       ON CONFLICT (thread_id, source_claim_id, source_outcome_id) DO NOTHING`,
      [previousId, input.newClaimId],
    );
    await client.query(
      `INSERT INTO claim_relations
         (source_claim_id, target_claim_id, family_id, scope, scope_partition_key,
          relation_type, detection_method, detection_metadata)
       SELECT id, $2, family_id, scope, scope_partition_key, 'temporal_update',
              'deterministic_exact', jsonb_build_object('method', 'slot_attribute', 'attribute', $3::text)
         FROM memory_items WHERE id = $1`,
      [previousId, input.newClaimId, input.attribute],
    );
    await client.query(
      `UPDATE memory_items SET claim_status = 'superseded', superseded_by = $2,
              duplicate_of = NULL, updated_at = now() WHERE id = $1`,
      [previousId, input.newClaimId],
    );
    await client.query(
      `INSERT INTO audit_events (family_id, actor_user_id, event_type, subject_id, metadata)
       VALUES ($1, $2, 'memory.superseded', $3,
               jsonb_build_object('scope', $4::text, 'attribute', $5::text, 'supersededBy', $6::text))`,
      [auth.familyId, input.systemActor ? null : auth.userId, previousId, input.scope,
        input.attribute, input.newClaimId],
    );
  }
  return ids;
}
