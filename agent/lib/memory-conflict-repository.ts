/**
 * Scoped, replay-safe claim-conflict resolution boundary.
 *
 * Exports:
 * - `MemoryConflictResolution`: model-safe result containing only opaque refs.
 * - `memoryConflictRepository.resolve`: re-authorizes and records one explicit user decision.
 */
import type { PoolClient } from "pg";

import { AppError } from "./app-error.js";
import { database } from "./database.js";
import { validatedMemorySpace, type MemoryAuthorization, type MemoryScope } from "./memory-context.js";
import { memoryOperationHash } from "./memory-record.js";
import { MEMORY_REF_PATTERN } from "./model-memory.js";

export const CONFLICT_REF_PATTERN = /^conf_[0-9a-f]{32}$/u;

export type ResolveMemoryConflictInput =
  | { action: "choose"; conflictRef: string; memoryRef: string; operationKey: string }
  | { action: "keep_both" | "keep_unresolved"; conflictRef: string; operationKey: string };

export interface MemoryConflictResolution {
  chosenMemoryRef?: string;
  conflictRef: string;
  resolution: "chosen" | "keep_both" | "unresolved";
}

interface ConflictRow {
  a_space_id: string | null;
  b_space_id: string | null;
  author_a_telegram_user_id: string | null;
  author_a_user_id: string | null;
  author_b_telegram_user_id: string | null;
  author_b_user_id: string | null;
  claim_a_id: string;
  claim_b_id: string;
  conflict_ref: string;
  id: string;
  memory_ref_a: string;
  memory_ref_b: string;
  owner_a_user_id: string | null;
  owner_b_user_id: string | null;
  resolution: "chosen" | "keep_both" | "unresolved";
  scope: MemoryScope;
  scope_partition_key: string;
}

async function currentAccess(
  client: PoolClient,
  auth: MemoryAuthorization,
  conflict: ConflictRow,
): Promise<void> {
  if (!auth.scopes.includes(conflict.scope)) {
    throw new AppError("AGENT_MEMORY_CONFLICT_SCOPE_DENIED", "Конфликт недоступен в текущем чате");
  }
  // Разрешение конфликта отзывает одну из версий, поэтому обе обязаны принадлежать области хода:
  // иначе решение, принятое в одной области, меняет запись в другой.
  const space = validatedMemorySpace(auth.space);
  if (space && (conflict.a_space_id !== space.spaceId || conflict.b_space_id !== space.spaceId)) {
    throw new AppError("AGENT_MEMORY_CONFLICT_SCOPE_DENIED", "Конфликт недоступен в текущем чате");
  }
  const membership = auth.userId
    ? await client.query<{ role: "member" | "owner" }>(
        `SELECT role FROM family_memberships
         WHERE family_id = $1 AND user_id = $2 FOR SHARE`,
        [auth.familyId, auth.userId],
      )
    : { rows: [] };
  const currentOwner = membership.rows[0]?.role === "owner";
  const allowed = conflict.scope === "personal"
    ? Boolean(
        auth.userId && membership.rows[0] &&
        conflict.owner_a_user_id === auth.userId && conflict.owner_b_user_id === auth.userId &&
        conflict.scope_partition_key === auth.userId
      )
    : conflict.scope === "family"
      // Authorship alone is not enough: the author must still be a member of the family.
      ? Boolean(membership.rows[0]) && (currentOwner || Boolean(
          auth.userId && conflict.author_a_user_id === auth.userId &&
          conflict.author_b_user_id === auth.userId
        ))
      : Boolean(
          auth.groupId === conflict.scope_partition_key &&
          (currentOwner || (
            conflict.author_a_telegram_user_id === auth.telegramUserId &&
            conflict.author_b_telegram_user_id === auth.telegramUserId
          ))
        );
  if (!allowed) {
    throw new AppError(
      "AGENT_MEMORY_CONFLICT_RESOLUTION_DENIED",
      "Разрешить этот конфликт может его личный владелец, общий автор или текущий владелец семьи",
    );
  }
  if (conflict.scope === "group") {
    const group = await client.query(
      "SELECT 1 FROM telegram_groups WHERE id = $1 AND family_id = $2 FOR SHARE",
      [auth.groupId, auth.familyId],
    );
    if (!group.rowCount) {
      throw new AppError("AGENT_GROUP_NOT_REGISTERED", "Эта группа больше не подключена к агенту");
    }
  }
}

function resultFor(conflict: ConflictRow, input: ResolveMemoryConflictInput): MemoryConflictResolution {
  if (input.action === "choose") {
    return { chosenMemoryRef: input.memoryRef, conflictRef: conflict.conflict_ref, resolution: "chosen" };
  }
  return {
    conflictRef: conflict.conflict_ref,
    resolution: input.action === "keep_both" ? "keep_both" : "unresolved",
  };
}

export const memoryConflictRepository = {
  async resolve(
    auth: MemoryAuthorization,
    input: ResolveMemoryConflictInput,
  ): Promise<MemoryConflictResolution> {
    if (
      !CONFLICT_REF_PATTERN.test(input.conflictRef) ||
      (input.action === "choose" && !MEMORY_REF_PATTERN.test(input.memoryRef))
    ) {
      throw new AppError(
        "AGENT_MEMORY_CONFLICT_INPUT_INVALID",
        "Для разрешения конфликта нужны безопасные ссылки из контекста памяти",
      );
    }
    const inputHash = memoryOperationHash(input);
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const conflicts = await client.query<ConflictRow>(
        `SELECT conflict.id, conflict.conflict_ref, conflict.claim_a_id, conflict.claim_b_id,
                conflict.scope, conflict.scope_partition_key, conflict.resolution,
                a.owner_user_id AS owner_a_user_id, b.owner_user_id AS owner_b_user_id,
                a.author_user_id AS author_a_user_id, b.author_user_id AS author_b_user_id,
                a.author_telegram_user_id AS author_a_telegram_user_id,
                b.author_telegram_user_id AS author_b_telegram_user_id,
                ref_a.memory_ref AS memory_ref_a, ref_b.memory_ref AS memory_ref_b,
                a.space_id AS a_space_id, b.space_id AS b_space_id
         FROM claim_conflicts AS conflict
         JOIN memory_items AS a ON a.id = conflict.claim_a_id
         JOIN memory_items AS b ON b.id = conflict.claim_b_id
         JOIN memory_item_refs AS ref_a ON ref_a.memory_item_id = a.id
         JOIN memory_item_refs AS ref_b ON ref_b.memory_item_id = b.id
         WHERE conflict.conflict_ref = $1 AND conflict.family_id = $2
         FOR UPDATE OF conflict, a, b`,
        [input.conflictRef, auth.familyId],
      );
      const conflict = conflicts.rows[0];
      if (!conflict) {
        throw new AppError("AGENT_MEMORY_CONFLICT_NOT_FOUND", "Конфликт не найден");
      }
      await currentAccess(client, auth, conflict);

      // A matching operation is a read-only replay; a changed payload under the same key is denied.
      const replay = await client.query<{ input_hash: string }>(
        `SELECT input_hash FROM memory_conflict_resolution_operations
         WHERE family_id = $1 AND operation_key = $2`,
        [auth.familyId, input.operationKey],
      );
      if (replay.rows[0]) {
        if (replay.rows[0].input_hash !== inputHash) {
          throw new AppError(
            "AGENT_MEMORY_REPLAY_MISMATCH",
            "Повтор решения конфликта не совпадает с исходным запросом",
          );
        }
        await client.query("COMMIT");
        return resultFor(conflict, input);
      }
      if (conflict.resolution !== "unresolved") {
        throw new AppError(
          "AGENT_MEMORY_CONFLICT_ALREADY_RESOLVED",
          "Этот конфликт уже разрешён другим подтверждённым решением",
        );
      }

      let chosenClaimId: string | null = null;
      if (input.action === "choose") {
        chosenClaimId = input.memoryRef === conflict.memory_ref_a
          ? conflict.claim_a_id
          : input.memoryRef === conflict.memory_ref_b
            ? conflict.claim_b_id
            : null;
        if (!chosenClaimId) {
          throw new AppError(
            "AGENT_MEMORY_CONFLICT_CHOICE_INVALID",
            "Выбранная запись не относится к этому конфликту",
          );
        }
        const retractedId = chosenClaimId === conflict.claim_a_id
          ? conflict.claim_b_id
          : conflict.claim_a_id;
        await client.query(
          `UPDATE memory_items SET claim_status = 'retracted', superseded_by = NULL,
                  duplicate_of = NULL, updated_at = now() WHERE id = $1`,
          [retractedId],
        );
        await client.query(
          `UPDATE claim_conflicts SET resolution = 'chosen', chosen_claim_id = $2,
                  resolved_by_user_id = $3, resolved_by_telegram_user_id = $4,
                  resolution_metadata = jsonb_build_object('action', 'choose'), resolved_at = now()
           WHERE id = $1`,
          [conflict.id, chosenClaimId, auth.userId, auth.telegramUserId],
        );
      } else if (input.action === "keep_both") {
        await client.query(
          `UPDATE claim_conflicts SET resolution = 'keep_both', resolved_by_user_id = $2,
                  resolved_by_telegram_user_id = $3,
                  resolution_metadata = jsonb_build_object('action', 'keep_both'), resolved_at = now()
           WHERE id = $1`,
          [conflict.id, auth.userId, auth.telegramUserId],
        );
      }

      await client.query(
        `INSERT INTO memory_conflict_resolution_operations
           (family_id, operation_key, input_hash, conflict_id, action, chosen_claim_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [auth.familyId, input.operationKey, inputHash, conflict.id, input.action, chosenClaimId],
      );
      await client.query(
        `INSERT INTO audit_events (family_id, actor_user_id, event_type, subject_id, metadata)
         VALUES ($1, $2, 'memory.conflict_resolved', $3,
                 jsonb_build_object('action', $4::text, 'conflictRef', $5::text))`,
        [auth.familyId, auth.userId, conflict.id, input.action, conflict.conflict_ref],
      );
      await client.query("COMMIT");
      return resultFor(conflict, input);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
};
