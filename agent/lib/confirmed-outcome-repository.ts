/**
 * Authoritative application-event confirmed outcome repository.
 *
 * Exports:
 * - Confirmed outcome identity/source contracts for application integrations.
 * - `confirmedOutcomeRepository`: replay-safe creation and guarded lifecycle retraction.
 */
import type { PoolClient } from "pg";

import { AppError } from "./app-error.js";
import { database } from "./database.js";
import type { MemoryScope } from "./memory-context.js";
import { memoryOperationHash } from "./memory-record.js";

type OutcomeSourceRole = "decision" | "episode" | "goal" | "lesson" | "method" | "open_loop" | "result";

export interface ConfirmedOutcomeIdentity {
  familyId: string;
  memoryProjectId: string | null;
  scope: MemoryScope;
  scopePartitionKey: string;
  subjectConversationId: string | null;
  subjectParticipantId: string | null;
  subjectUserId: string | null;
}

export interface CreateConfirmedOutcomeInput extends ConfirmedOutcomeIdentity {
  applicationEventId: string;
  authority: "application_event" | "formal_goal_condition";
  occurredAt: Date;
  operationKey: string;
  sourceClaims: readonly { claimId: string; role: OutcomeSourceRole }[];
  sourceSnapshot: Readonly<Record<string, unknown>>;
  summary: string;
}

function requireIdentity(input: ConfirmedOutcomeIdentity): void {
  const identities = [input.subjectUserId, input.subjectParticipantId, input.memoryProjectId]
    .filter((value) => value !== null);
  const partitionValid =
    (input.scope === "personal" && input.subjectUserId === input.scopePartitionKey) ||
    (input.scope === "family" && input.scopePartitionKey === input.familyId &&
      input.subjectParticipantId === null) ||
    (input.scope === "group" && input.subjectUserId === null);
  if (identities.length !== 1 || !partitionValid ||
    ((input.subjectParticipantId === null) !== (input.subjectConversationId === null))) {
    throw new AppError(
      "AGENT_CONFIRMED_OUTCOME_IDENTITY_INVALID",
      "Не удалось определить проверенную identity подтверждённого результата",
    );
  }
}

async function replay(
  client: PoolClient,
  familyId: string,
  operationKey: string,
  action: "create" | "retract",
  inputHash: string,
): Promise<string | null> {
  const result = await client.query<{ action: string; input_hash: string; outcome_ref: string }>(
    `SELECT operation.action, operation.input_hash, outcome.outcome_ref
     FROM confirmed_outcome_operations AS operation
     JOIN confirmed_outcomes AS outcome ON outcome.id = operation.outcome_id
     WHERE operation.family_id = $1 AND operation.operation_key = $2`,
    [familyId, operationKey],
  );
  const existing = result.rows[0];
  if (!existing) return null;
  if (existing.action !== action || existing.input_hash !== inputHash) {
    throw new AppError(
      "AGENT_CONFIRMED_OUTCOME_REPLAY_MISMATCH",
      "Повтор операции с подтверждённым результатом не совпадает с исходным запросом",
    );
  }
  return existing.outcome_ref;
}

export const confirmedOutcomeRepository = {
  async create(input: CreateConfirmedOutcomeInput): Promise<{ outcomeRef: string }> {
    requireIdentity(input);
    if (!input.summary.trim() || input.summary.length > 4_000 ||
      input.sourceClaims.length !== new Set(input.sourceClaims.map((source) =>
        `${source.claimId}:${source.role}`
      )).size) {
      throw new AppError(
        "AGENT_CONFIRMED_OUTCOME_INPUT_INVALID",
        "Подтверждённый результат не содержит корректный summary или source refs",
      );
    }
    const inputHash = memoryOperationHash({ ...input, occurredAt: input.occurredAt.toISOString() });
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const replayed = await replay(client, input.familyId, input.operationKey, "create", inputHash);
      if (replayed) {
        await client.query("COMMIT");
        return { outcomeRef: replayed };
      }
      const event = await client.query(
        "SELECT 1 FROM audit_events WHERE id = $1 AND family_id = $2 FOR SHARE",
        [input.applicationEventId, input.familyId],
      );
      if (!event.rowCount) {
        throw new AppError(
          "AGENT_CONFIRMED_OUTCOME_EVENT_INVALID",
          "Application event подтверждённого результата не найден",
        );
      }
      const inserted = await client.query<{ id: string; outcome_ref: string }>(
        `INSERT INTO confirmed_outcomes
           (family_id, scope, scope_partition_key, subject_user_id, subject_participant_id,
            subject_conversation_id, memory_project_id, authority, application_event_id,
            source_snapshot, summary, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12)
         RETURNING id, outcome_ref`,
        [input.familyId, input.scope, input.scopePartitionKey, input.subjectUserId,
          input.subjectParticipantId, input.subjectConversationId, input.memoryProjectId,
          input.authority, input.applicationEventId, JSON.stringify(input.sourceSnapshot),
          input.summary, input.occurredAt],
      );
      const outcome = inserted.rows[0]!;
      for (const source of input.sourceClaims) {
        await client.query(
          `INSERT INTO confirmed_outcome_source_claims
             (outcome_id, source_claim_id, family_id, scope, scope_partition_key, source_role)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [outcome.id, source.claimId, input.familyId, input.scope,
            input.scopePartitionKey, source.role],
        );
      }
      await client.query(
        `INSERT INTO confirmed_outcome_operations
           (family_id, operation_key, input_hash, action, outcome_id)
         VALUES ($1, $2, $3, 'create', $4)`,
        [input.familyId, input.operationKey, inputHash, outcome.id],
      );
      await client.query("COMMIT");
      return { outcomeRef: outcome.outcome_ref };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async retract(input: {
    familyId: string;
    operationKey: string;
    outcomeRef: string;
  }): Promise<{ outcomeRef: string; status: "retracted" }> {
    const inputHash = memoryOperationHash({ outcomeRef: input.outcomeRef });
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const replayed = await replay(client, input.familyId, input.operationKey, "retract", inputHash);
      if (replayed) {
        await client.query("COMMIT");
        return { outcomeRef: replayed, status: "retracted" };
      }
      const outcome = await client.query<{ id: string }>(
        `SELECT id FROM confirmed_outcomes
         WHERE outcome_ref = $1 AND family_id = $2 AND status = 'confirmed' FOR UPDATE`,
        [input.outcomeRef, input.familyId],
      );
      const outcomeId = outcome.rows[0]?.id;
      if (!outcomeId) {
        throw new AppError("AGENT_CONFIRMED_OUTCOME_NOT_FOUND", "Подтверждённый результат не найден");
      }
      const completion = await client.query(
        "SELECT 1 FROM memory_threads WHERE completion_outcome_id = $1 AND status = 'completed'",
        [outcomeId],
      );
      if (completion.rowCount) {
        throw new AppError(
          "AGENT_CONFIRMED_OUTCOME_RETRACTION_BLOCKED",
          "Сначала явно реактивируйте завершённую нить памяти",
        );
      }
      await client.query(
        `UPDATE confirmed_outcomes SET status = 'retracted', retracted_at = now(), updated_at = now()
         WHERE id = $1`,
        [outcomeId],
      );
      await client.query(
        `INSERT INTO confirmed_outcome_operations
           (family_id, operation_key, input_hash, action, outcome_id)
         VALUES ($1, $2, $3, 'retract', $4)`,
        [input.familyId, input.operationKey, inputHash, outcomeId],
      );
      await client.query("COMMIT");
      return { outcomeRef: input.outcomeRef, status: "retracted" };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
};
