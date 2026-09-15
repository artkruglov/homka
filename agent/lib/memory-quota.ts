/**
 * Transactional long-term memory quota enforcement.
 *
 * Export:
 * - `enforceMemoryQuota`: serializes same-scope writers and rejects records above agreed limits.
 */
import type { PoolClient } from "pg";

import { AppError } from "./app-error.js";
import { MEMORY_SCOPE_QUOTAS } from "./memory-config.js";
import { resolveClaimPartition } from "./memory-claim-partition.js";
import type { MemoryAuthorization, MemoryScope } from "./memory-context.js";

export async function enforceMemoryQuota(
  client: PoolClient,
  auth: MemoryAuthorization,
  scope: MemoryScope,
): Promise<void> {
  const partition = resolveClaimPartition(auth, scope);
  // Две области одной семьи получают каждая свой лимит и свою блокировку: иначе запись в одной
  // подпирала бы запись в другой, а заполненная область закрывала бы обе.
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [partition.spaceId === null
      ? `memory:${scope}:${auth.familyId}:${partition.scopePartitionKey}`
      : `memory:space:${partition.spaceId}`],
  );
  const result = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM memory_items
     WHERE family_id = $1 AND scope = $2
       AND ($2 <> 'personal' OR owner_user_id = $3)
       AND ($2 <> 'group' OR group_id = $4)
       AND ($5::uuid IS NULL OR space_id = $5::uuid)`,
    [auth.familyId, scope, auth.userId, auth.groupId, partition.spaceId],
  );
  if (Number(result.rows[0]?.count) >= MEMORY_SCOPE_QUOTAS[scope]) {
    throw new AppError(
      "AGENT_MEMORY_QUOTA_EXCEEDED",
      "Достигнут лимит записей памяти. Удалите ненужные записи и повторите попытку",
    );
  }
}
