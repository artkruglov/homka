/**
 * Owner-managed external self-projection policy boundary.
 *
 * Exports:
 * - `ExternalProfileProjectionPolicy`: opaque owner-facing policy status.
 * - `profileProjectionPolicyRepository`: replay-safe policy and durable notice-delivery lifecycle.
 */
import type { PoolClient } from "pg";

import { AppError } from "./app-error.js";
import { database } from "./database.js";
import type { MemoryAuthorization } from "./memory-context.js";
import { PROFILE_PROJECTION_NOTICE_LEASE_MILLISECONDS } from "./memory-config.js";
import { memoryOperationHash } from "./memory-record.js";

export interface ExternalProfileProjectionPolicy {
  enabled: boolean;
  groupRef: string;
  label: string;
  policyVersion: number;
}

async function requireCurrentOwner(client: PoolClient, auth: MemoryAuthorization): Promise<void> {
  if (!auth.userId || auth.role !== "owner") {
    throw new AppError(
      "AGENT_PROFILE_PROJECTION_OWNER_REQUIRED",
      "Изменять проекцию профиля может только владелец семьи",
    );
  }
  const owner = await client.query(
    `SELECT 1 FROM family_memberships
     WHERE family_id = $1 AND user_id = $2 AND role = 'owner' FOR SHARE`,
    [auth.familyId, auth.userId],
  );
  if (!owner.rowCount) {
    throw new AppError(
      "AGENT_PROFILE_PROJECTION_OWNER_REQUIRED",
      "Права владельца больше не действуют. Обновите чат и повторите действие",
    );
  }
}

function policyNotice(enabled: boolean): string {
  return enabled
    ? "Владелец включил проекцию подтверждённых сведений об участнике из этой внешней группы в его личный профиль. Личная и семейная память группе не раскрывается."
    : "Владелец отключил проекцию сведений из этой внешней группы в личные профили участников. Уже сохранённые групповые claims остаются только в области группы.";
}

export const profileProjectionPolicyRepository = {
  async list(auth: MemoryAuthorization): Promise<ExternalProfileProjectionPolicy[]> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      await requireCurrentOwner(client, auth);
      const result = await client.query<{
        enabled: boolean;
        group_ref: string;
        label: string;
        policy_version: number;
      }>(
        `SELECT policy.group_ref, policy.enabled, policy.policy_version,
                conversation.label
         FROM external_profile_projection_policies AS policy
         JOIN application_conversations AS conversation
           ON conversation.telegram_group_id = policy.group_id
         WHERE policy.family_id = $1
         ORDER BY lower(conversation.label), policy.group_ref`,
        [auth.familyId],
      );
      await client.query("COMMIT");
      return result.rows.map((row) => ({
        enabled: row.enabled,
        groupRef: row.group_ref,
        label: row.label,
        policyVersion: row.policy_version,
      }));
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async claimPendingGroupNotice(groupId: string): Promise<{
    deliveryToken: string;
    noticeRef: string;
    text: string;
  } | null> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [groupId]);
      // A stale started delivery is ambiguous: retrying could duplicate a participant notice.
      await client.query(
        `UPDATE external_profile_projection_notices
         SET delivery_status = 'ambiguous', delivery_token = NULL,
             delivery_error_code = 'AGENT_PROFILE_PROJECTION_NOTICE_DELIVERY_AMBIGUOUS'
         WHERE group_id = $1 AND delivery_status = 'started' AND delivery_started_at < $2`,
        [groupId, new Date(Date.now() - PROFILE_PROJECTION_NOTICE_LEASE_MILLISECONDS)],
      );
      const result = await client.query<{
        delivery_token: string;
        notice_ref: string;
        notice_text: string;
      }>(
        `UPDATE external_profile_projection_notices AS notice
         SET delivery_status = 'started', delivery_token = gen_random_uuid(),
             delivery_started_at = now(), delivery_error_code = NULL
         WHERE notice.id = (
           SELECT pending.id FROM external_profile_projection_notices AS pending
           WHERE pending.group_id = $1 AND pending.delivery_status = 'pending'
           ORDER BY pending.policy_version LIMIT 1 FOR UPDATE SKIP LOCKED
         )
         RETURNING notice.delivery_token::text, notice.notice_ref, notice.notice_text`,
        [groupId],
      );
      await client.query("COMMIT");
      const row = result.rows[0];
      return row ? {
        deliveryToken: row.delivery_token,
        noticeRef: row.notice_ref,
        text: row.notice_text,
      } : null;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async markGroupNoticePresented(input: {
    deliveryToken: string;
    noticeRef: string;
  }): Promise<void> {
    const result = await database().query(
      `UPDATE external_profile_projection_notices
       SET delivery_status = 'presented', delivery_token = NULL, first_presented_at = now()
       WHERE notice_ref = $1 AND delivery_token = $2 AND delivery_status = 'started'`,
      [input.noticeRef, input.deliveryToken],
    );
    if (!result.rowCount) {
      throw new AppError(
        "AGENT_PROFILE_PROJECTION_NOTICE_ACK_INVALID",
        "Не удалось подтвердить доставку уведомления о проекции профиля",
      );
    }
  },

  async update(
    auth: MemoryAuthorization,
    input: { enabled: boolean; groupRef: string; operationKey: string },
  ): Promise<ExternalProfileProjectionPolicy & { changed: boolean; participantNotice: string }> {
    const inputHash = memoryOperationHash({ enabled: input.enabled, groupRef: input.groupRef });
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      await requireCurrentOwner(client, auth);
      const existingOperation = await client.query<{
        enabled: boolean;
        group_ref: string;
        input_hash: string;
        label: string;
        policy_version: number;
      }>(
        `SELECT operation.input_hash, operation.enabled, operation.policy_version,
                policy.group_ref, conversation.label
         FROM external_profile_projection_policy_operations AS operation
         JOIN external_profile_projection_policies AS policy ON policy.group_id = operation.group_id
         JOIN application_conversations AS conversation ON conversation.telegram_group_id = policy.group_id
         WHERE operation.family_id = $1 AND operation.operation_key = $2`,
        [auth.familyId, input.operationKey],
      );
      const replay = existingOperation.rows[0];
      if (replay) {
        if (replay.input_hash !== inputHash || replay.group_ref !== input.groupRef) {
          throw new AppError(
            "AGENT_PROFILE_PROJECTION_REPLAY_MISMATCH",
            "Повтор изменения политики не совпадает с исходным запросом",
          );
        }
        await client.query("COMMIT");
        return {
          changed: false,
          enabled: replay.enabled,
          groupRef: replay.group_ref,
          label: replay.label,
          participantNotice: policyNotice(replay.enabled),
          policyVersion: replay.policy_version,
        };
      }

      // Opaque ref and family are resolved in the same lock; raw Telegram/group IDs never cross API.
      const selected = await client.query<{
        enabled: boolean;
        group_id: string;
        label: string;
        notice_presented: boolean;
        policy_version: number;
      }>(
        `SELECT policy.group_id, policy.enabled, policy.policy_version, conversation.label,
                coalesce(notice.delivery_status = 'presented', false) AS notice_presented
         FROM external_profile_projection_policies AS policy
         JOIN application_conversations AS conversation ON conversation.telegram_group_id = policy.group_id
         LEFT JOIN external_profile_projection_notices AS notice
           ON notice.group_id = policy.group_id AND notice.policy_version = policy.policy_version
         WHERE policy.family_id = $1 AND policy.group_ref = $2 FOR UPDATE OF policy`,
        [auth.familyId, input.groupRef],
      );
      const policy = selected.rows[0];
      if (!policy) {
        throw new AppError(
          "AGENT_PROFILE_PROJECTION_GROUP_NOT_FOUND",
          "Внешняя группа с такой безопасной ссылкой не найдена",
        );
      }
      const changed = policy.enabled !== input.enabled || !policy.notice_presented;
      const policyVersion = changed ? policy.policy_version + 1 : policy.policy_version;
      if (changed) {
        // Owner recovery must not depend on another accepted group message after a worker crash.
        await client.query(
          `UPDATE external_profile_projection_notices
           SET delivery_status = 'ambiguous', delivery_token = NULL,
               delivery_error_code = 'AGENT_PROFILE_PROJECTION_NOTICE_DELIVERY_AMBIGUOUS'
           WHERE group_id = $1 AND delivery_status = 'started' AND delivery_started_at < $2`,
          [policy.group_id, new Date(Date.now() - PROFILE_PROJECTION_NOTICE_LEASE_MILLISECONDS)],
        );
        const activeDelivery = await client.query(
          `SELECT 1 FROM external_profile_projection_notices
           WHERE group_id = $1 AND delivery_status = 'started' FOR UPDATE`,
          [policy.group_id],
        );
        if (activeDelivery.rowCount) {
          throw new AppError(
            "AGENT_PROFILE_PROJECTION_NOTICE_DELIVERY_ACTIVE",
            "Предыдущее уведомление группы ещё доставляется. Повторите изменение политики позже",
          );
        }
        // An unseen older state must never be presented after a newer owner decision.
        await client.query(
          `UPDATE external_profile_projection_notices
           SET delivery_status = 'failed',
               delivery_error_code = 'AGENT_PROFILE_PROJECTION_NOTICE_SUPERSEDED'
           WHERE group_id = $1 AND delivery_status = 'pending'`,
          [policy.group_id],
        );
        await client.query(
          `UPDATE external_profile_projection_policies
           SET enabled = $1, policy_version = $2, updated_by_user_id = $3, updated_at = now()
           WHERE group_id = $4`,
          [input.enabled, policyVersion, auth.userId, policy.group_id],
        );
        await client.query(
          `INSERT INTO external_profile_projection_notices
             (group_id, family_id, policy_version, enabled, notice_text, created_by_user_id)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [policy.group_id, auth.familyId, policyVersion, input.enabled,
            policyNotice(input.enabled), auth.userId],
        );
      }
      await client.query(
        `INSERT INTO external_profile_projection_policy_operations
           (family_id, operation_key, input_hash, group_id, policy_version, enabled)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [auth.familyId, input.operationKey, inputHash, policy.group_id, policyVersion, input.enabled],
      );
      if (changed) {
        await client.query(
          `INSERT INTO audit_events (family_id, actor_user_id, event_type, subject_id, metadata)
           VALUES ($1, $2, 'external_profile_projection.updated', $3,
                   jsonb_build_object('enabled', $4::boolean, 'policyVersion', $5::integer))`,
          [auth.familyId, auth.userId, policy.group_id, input.enabled, policyVersion],
        );
      }
      await client.query("COMMIT");
      return {
        changed,
        enabled: input.enabled,
        groupRef: input.groupRef,
        label: policy.label,
        participantNotice: policyNotice(input.enabled),
        policyVersion,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
};
