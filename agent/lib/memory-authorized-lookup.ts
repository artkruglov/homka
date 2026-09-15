/**
 * Поиск записи памяти, доступной текущему ходу, по её непрозрачной ссылке или внутреннему ID.
 *
 * Экспорт:
 * - `MutationMemoryRow`: строка, на которой работают правка, удаление и отмена.
 * - `selectAuthorizedMemory`: единственный вход к записи перед любой её мутацией.
 *
 * Через него проходит каждая правка памяти, поэтому область проверяется здесь же: живое членство и
 * регистрацию группы проверяет отдельно `requireMutationAccess`, а эта выборка отвечает за то,
 * чтобы ссылка из чужой области вообще ничего не нашла.
 */
import type { PoolClient } from "pg";

import { memorySpaceParameters, type MemoryAuthorization } from "./memory-context.js";
import type { ReferencedMemoryRow } from "./memory-record.js";
import { spaceReadClause } from "./spaces/space-sql.js";

export interface MutationMemoryRow extends ReferencedMemoryRow {
  claim_status: "active" | "duplicate" | "superseded";
  group_id: string | null;
  memory_project_id: string | null;
  origin_conversation_id: string | null;
  owner_user_id: string | null;
  profile_eligible: boolean;
  subject_conversation_id: string | null;
  subject_family_id: string | null;
  subject_label: string | null;
  subject_participant_id: string | null;
  subject_user_id: string | null;
  superseded_by: string | null;
}

export async function selectAuthorizedMemory(
  client: PoolClient,
  auth: MemoryAuthorization,
  lookupValue: string,
  lookupBy: "id" | "ref",
  lock = false,
): Promise<MutationMemoryRow | null> {
  // Scope predicates run in the same lookup that resolves the opaque ref to an internal UUID.
  const result = await client.query<MutationMemoryRow>(
    `SELECT item.id, item.author_user_id, item.author_telegram_user_id, item.scope, item.kind,
            item.content, item.source, item.confirmation, item.sensitivity, item.message_thread_id,
             item.embedding_status, item.created_at, item.updated_at, item.occurred_at, ref.memory_ref,
             item.owner_user_id, item.group_id, item.origin_conversation_id,
             item.subject_family_id, item.subject_user_id, item.subject_participant_id,
             item.subject_conversation_id, item.subject_label, item.memory_project_id,
              item.profile_eligible, item.claim_status, item.superseded_by
     FROM memory_item_refs AS ref
     JOIN memory_items AS item ON item.id = ref.memory_item_id
      WHERE ${lookupBy === "ref" ? "ref.memory_ref" : "item.id"} = $1
       AND item.family_id = $2
       AND (
         (item.scope = 'personal' AND 'personal' = ANY($3::memory_scope[]) AND item.owner_user_id = $4) OR
         (item.scope = 'family' AND 'family' = ANY($3::memory_scope[])) OR
         (item.scope = 'group' AND 'group' = ANY($3::memory_scope[]) AND item.group_id = $5)
       )
       AND ${spaceReadClause({
    pinned: true,
         alias: "item",
         parameters: { family: "$2", group: "$5", spaceId: "$6", user: "$4", version: "$7" },
       })}
     ${lock ? "FOR UPDATE OF item" : ""}`,
    [lookupValue, auth.familyId, auth.scopes, auth.userId, auth.groupId,
      ...memorySpaceParameters(auth)],
  );
  return result.rows[0] ?? null;
}
