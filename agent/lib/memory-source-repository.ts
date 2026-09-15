/**
 * Projection-aware personal provenance source lookup.
 *
 * Exports:
 * - `MemorySourceLookup`: safe source summary without database or Telegram identifiers.
 * - `memorySourceRepository.lookup`: re-authorizes personal, family, and opted-in self projections.
 */
import { AppError } from "./app-error.js";
import { database } from "./database.js";
import { memorySpaceParameters, type MemoryAuthorization } from "./memory-context.js";
import { spaceReadClause } from "./spaces/space-sql.js";
import { MEMORY_REF_PATTERN } from "./model-memory.js";
import { externalProfileProjectionPredicate } from "./external-profile-projection-predicate.js";

export interface MemorySourceLookup {
  evidenceSnippet: string;
  fullTimelineSourceAvailable: boolean;
  observedAt: string;
  originChatLabel: string;
  sourceAuthorLabel: string;
  telegramLink?: string;
}

export const memorySourceRepository = {
  async lookup(auth: MemoryAuthorization, memoryRef: string): Promise<MemorySourceLookup> {
    if (!auth.userId || !auth.scopes.includes("personal") || !MEMORY_REF_PATTERN.test(memoryRef)) {
      throw new AppError(
        "AGENT_MEMORY_SOURCE_SCOPE_DENIED",
        "Источник памяти можно проверить только из личного чата по безопасной ссылке",
      );
    }
    const result = await database().query<{
      author_label: string;
      evidence_snippet: string;
      full_timeline_source_available: boolean;
      observed_at: Date;
      origin_label: string;
    }>(
      `SELECT evidence.origin_conversation_label_snapshot AS origin_label,
              coalesce(evidence.author_label_snapshot, 'Участник Telegram') AS author_label,
              evidence.observed_at, evidence.evidence_snippet,
              evidence.timeline_entry_id IS NOT NULL AS full_timeline_source_available
       FROM memory_item_refs AS ref
       JOIN memory_items AS claim ON claim.id = ref.memory_item_id
       JOIN claim_evidence AS evidence
         ON evidence.claim_id = claim.id AND evidence.evidence_role = 'primary'
       LEFT JOIN conversation_participants AS subject
         ON subject.id = claim.subject_participant_id
        WHERE ref.memory_ref = $1 AND claim.family_id = $2
         AND EXISTS (
           SELECT 1 FROM family_memberships
           WHERE family_id = $2 AND user_id = $3
         )
         AND (
           (claim.scope = 'personal' AND claim.owner_user_id = $3) OR
            (claim.scope = 'family' AND claim.profile_eligible = true
              AND (claim.subject_user_id = $3 OR subject.linked_user_id = $3)) OR
            ${externalProfileProjectionPredicate({ claimAlias: "claim", viewerUserParameter: "$3" })}
          )
          AND ${spaceReadClause({
            alias: "claim",
            parameters: { family: "$2", group: "$4", spaceId: "$5", user: "$3", version: "$6" },
          })}`,
      [memoryRef, auth.familyId, auth.userId, auth.groupId, ...memorySpaceParameters(auth)],
    );
    const row = result.rows[0];
    if (!row) {
      throw new AppError(
        "AGENT_MEMORY_SOURCE_NOT_FOUND",
        "Источник не найден или больше не доступен в вашем личном профиле",
      );
    }
    // No Telegram username is persisted and numeric deep links would expose transport identity, so
    // this DTO intentionally omits telegramLink unless a future source can prove a safe public URL.
    return {
      evidenceSnippet: row.evidence_snippet,
      fullTimelineSourceAvailable: row.full_timeline_source_available,
      observedAt: row.observed_at.toISOString(),
      originChatLabel: row.origin_label,
      sourceAuthorLabel: row.author_label,
    };
  },
};
