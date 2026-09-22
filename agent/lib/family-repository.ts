/**
 * PostgreSQL family administration adapter.
 *
 * Exports:
 * - `PendingFamilyInvitation`: owner-visible pending candidate projection.
 * - `FamilyRepository`: injectable invitation administration contract.
 * - `familyRepository`: transactional family administration implementation.
 * - Durable invitation transport reservation with live owner authorization.
 */
import { AppError } from "./app-error.js";
import { database } from "./database.js";
import { provisionMemberPersonalSpace } from "./spaces/space-provisioning.js";
import { requireAdministrationSpace } from "./spaces/administration-space.js";
import type { SpaceAttributes } from "./spaces/space-attributes.js";
import {
  createInvitationCodeForOperation,
  hashInvitationCode,
  INVITATION_CODE_TTL_MS,
  requireInvitationSigningSecret,
} from "./invitation-code.js";
import type { TelegramProfile } from "./telegram-repository.js";

export interface PendingFamilyInvitation {
  claimedAt: string;
  displayName: string;
  expiresAt: string;
  invitationId: string;
  telegramUserId: string;
  username: string | null;
}

interface ApproveInvitationInput {
  space?:SpaceAttributes;
  approvedBy: string;
  candidateDisplayName: string;
  candidateTelegramUserId: string;
  familyId: string;
  invitationId: string;
  operationKey: string;
}

function invitationDeliveryAmbiguousError(): AppError {
  return new AppError(
    "AGENT_INVITATION_DELIVERY_AMBIGUOUS",
    "Не удалось подтвердить отправку приглашения. Проверьте личный чат; повторная отправка этой ссылки заблокирована",
  );
}

export type FamilyRelation = "child" | "other" | "parent" | "partner";

export interface FamilyRepository {
  approveInvitation(input: ApproveInvitationInput): Promise<{ approved: true }>;
  /** Кто кому кто: метка отношения участника к владельцу семьи. Прав она не даёт. */
  setRelation(input: {
    familyId: string;
    ownerUserId: string;
    participantRef: string;
    relation: FamilyRelation;
  }): Promise<{ name: string; relation: FamilyRelation }>;
  claimInvitation(code: string, profile: TelegramProfile): Promise<"invalid" | "pending">;
  createInvitation(
    familyId: string,
    createdBy: string,
    operationKey: string,
    space?:SpaceAttributes,
  ): Promise<{
    code: string;
    deliveryRequired: boolean;
    expiresAt: string;
    invitationId: string;
  }>;
  listPendingInvitations(
    familyId: string,
    requestedBy: string,
  ): Promise<PendingFamilyInvitation[]>;
  markInvitationDelivered(input: {
    createdBy: string;
    familyId: string;
    invitationId: string;
    operationKey: string;
  }): Promise<void>;
  markInvitationDeliveryStarted(input: {
    createdBy: string;
    familyId: string;
    invitationId: string;
    operationKey: string;
  }): Promise<void>;
}

export const familyRepository: FamilyRepository = {
  async setRelation(input) {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      // Роль владельца перепроверяется живым запросом, а участник берётся по ref семейного списка.
      const updated = await client.query<{ display_name: string }>(
        `UPDATE family_memberships AS membership SET relation = $4
           FROM users AS person, shared_task_participants AS participant
          WHERE participant.id = $3 AND participant.family_id = $1 AND participant.group_id IS NULL
            AND person.telegram_user_id = participant.telegram_user_id
            AND membership.user_id = person.id AND membership.family_id = $1
            AND membership.user_id <> $2
            AND EXISTS (SELECT 1 FROM family_memberships AS owner
                         WHERE owner.family_id = $1 AND owner.user_id = $2 AND owner.role = 'owner')
          RETURNING person.display_name`,
        [input.familyId, input.ownerUserId, input.participantRef, input.relation],
      );
      if (updated.rowCount !== 1) {
        throw new AppError(
          "AGENT_FAMILY_RELATION_INVALID",
          "Не нашла этого участника семьи. Возьмите participantRef из списка участников",
        );
      }
      await client.query(
        `INSERT INTO audit_events (family_id, actor_user_id, event_type, metadata)
         VALUES ($1, $2, 'family.relation', jsonb_build_object('relation', $3::text))`,
        [input.familyId, input.ownerUserId, input.relation],
      );
      await client.query("COMMIT");
      console.info(JSON.stringify({
        code: "AGENT_FAMILY_RELATION_SET", familyId: input.familyId, relation: input.relation,
      }));
      return { name: updated.rows[0]!.display_name, relation: input.relation };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async claimInvitation(code, profile) {
    const client = await database().connect();
    try {
      await client.query("BEGIN");

      // The invitation lock reserves a one-time code for exactly one Telegram identity.
      const invitation = await client.query<{ family_id: string; id: string }>(
        `SELECT id, family_id
         FROM invitations
         WHERE code_hash = $1 AND status = 'open' AND expires_at >= now()
         FOR UPDATE`,
        [hashInvitationCode(code)],
      );
      const row = invitation.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return "invalid";
      }

      // Upsert locks a reused Telegram identity, serializing concurrent claims by that caller.
      const user = await client.query<{ id: string }>(
        `INSERT INTO users (telegram_user_id, display_name, telegram_username)
         VALUES ($1, $2, $3)
         ON CONFLICT (telegram_user_id)
         DO UPDATE SET display_name = EXCLUDED.display_name, telegram_username = EXCLUDED.telegram_username
         RETURNING id`,
        [profile.telegramUserId, profile.displayName, profile.username ?? null],
      );
      const candidateId = user.rows[0]?.id;
      if (!candidateId) {
        throw new Error("AGENT_INVITATION_CANDIDATE_WRITE_FAILED: Кандидат не был сохранен");
      }

      // Expiration releases the unique pending slot before checking this candidate's new claim.
      await client.query(
        `UPDATE invitations
         SET status = 'expired'
         WHERE family_id = $1 AND claimed_by = $2
           AND status = 'pending' AND expires_at < now()`,
        [row.family_id, candidateId],
      );

      // Existing membership or an earlier live pending request makes this code ineligible.
      const existingAccess = await client.query<{ blocked: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM family_memberships WHERE user_id = $1
           UNION ALL
           SELECT 1 FROM invitations
           WHERE family_id = $2 AND claimed_by = $1 AND status = 'pending'
         ) AS blocked`,
        [candidateId, row.family_id],
      );
      if (existingAccess.rows[0]?.blocked) {
        await client.query("ROLLBACK");
        return "invalid";
      }

      // Pending state persists the candidate for owner review without granting membership.
      await client.query(
        `UPDATE invitations
         SET status = 'pending', claimed_at = now(), claimed_by = $2
         WHERE id = $1`,
        [row.id, candidateId],
      );
      await client.query(
        `INSERT INTO audit_events
           (family_id, actor_user_id, event_type, subject_id, metadata)
         VALUES ($1, $2, 'invitation.claimed', $3, jsonb_build_object('telegramUserId', $4::text))`,
        [row.family_id, candidateId, row.id, profile.telegramUserId],
      );
      await client.query("COMMIT");
      return "pending";
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async createInvitation(familyId, createdBy, operationKey, space) {
    const client = await database().connect();
    try {
      await client.query("BEGIN");

      // Lock current membership so a stale Eve approval cannot race an owner-role revocation.
      await requireAdministrationSpace(client,familyId,createdBy,space);
      const owner = await client.query(
        `SELECT 1
         FROM family_memberships
         WHERE family_id = $1 AND user_id = $2 AND role = 'owner'
         FOR SHARE`,
        [familyId, createdBy],
      );
      if (!owner.rowCount) {
        throw new AppError("AGENT_OWNER_REQUIRED", "Это действие доступно только владельцу");
      }

      // A code derived from callId is reproducible after Eve replays an interrupted tool step.
      const generated = createInvitationCodeForOperation(
        `${familyId}:${createdBy}:${operationKey}`,
        requireInvitationSigningSecret(),
      );
      const expiresAt = new Date(Date.now() + INVITATION_CODE_TTL_MS);
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO invitations
           (family_id, created_by, operation_key, code_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (family_id, created_by, operation_key) DO NOTHING
         RETURNING id`,
        [familyId, createdBy, operationKey, generated.codeHash, expiresAt],
      );
      const insertedId = inserted.rows[0]?.id;
      if (insertedId) {
        await client.query(
          `INSERT INTO audit_events
             (family_id, actor_user_id, event_type, subject_id, metadata)
           VALUES ($1, $2, 'invitation.created', $3, jsonb_build_object('operationKey', $4::text))`,
          [familyId, createdBy, insertedId, operationKey],
        );
      }
      const result = await client.query<{
        code_hash: string;
        delivery_completed_at: Date | null;
        delivery_started_at: Date | null;
        expires_at: Date;
        id: string;
        status: string;
      }>(
        `SELECT id, code_hash, expires_at, delivery_started_at, delivery_completed_at, status
         FROM invitations
         WHERE family_id = $1 AND created_by = $2 AND operation_key = $3`,
        [familyId, createdBy, operationKey],
      );
      const invitation = result.rows[0];
      if (!invitation || invitation.code_hash !== generated.codeHash) {
        throw new Error(
          "AGENT_INVITATION_REPLAY_MISMATCH: Не удалось безопасно восстановить приглашение",
        );
      }
      if (invitation.delivery_started_at !== null && invitation.delivery_completed_at === null) {
        throw invitationDeliveryAmbiguousError();
      }
      if (
        invitation.status === "open" &&
        invitation.expires_at.getTime() <= Date.now()
      ) {
        throw new AppError(
          "AGENT_INVITATION_EXPIRED",
          "Срок приглашения истек. Создайте новое приглашение",
        );
      }

      await client.query("COMMIT");
      return {
        code: generated.code,
        deliveryRequired:
          invitation.status === "open" && invitation.delivery_completed_at === null,
        expiresAt: invitation.expires_at.toISOString(),
        invitationId: invitation.id,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async listPendingInvitations(familyId, requestedBy) {
    const client = await database().connect();
    try {
      await client.query("BEGIN");

      // A shared lock prevents candidate data from racing current owner-role revocation.
      const owner = await client.query(
        `SELECT 1
         FROM family_memberships
         WHERE family_id = $1 AND user_id = $2 AND role = 'owner'
         FOR SHARE`,
        [familyId, requestedBy],
      );
      if (!owner.rowCount) {
        throw new AppError("AGENT_OWNER_REQUIRED", "Это действие доступно только владельцу");
      }

      // Persist terminal expiry state so it no longer occupies a candidate's pending slot.
      await client.query(
        `UPDATE invitations
         SET status = 'expired'
         WHERE family_id = $1 AND status = 'pending' AND expires_at < now()`,
        [familyId],
      );

      const result = await client.query<{
        claimed_at: Date;
        display_name: string;
        expires_at: Date;
        invitation_id: string;
        telegram_user_id: string;
        telegram_username: string | null;
      }>(
        `SELECT i.id AS invitation_id, i.claimed_at, i.expires_at,
                u.display_name, u.telegram_user_id, u.telegram_username
         FROM invitations i
         JOIN users u ON u.id = i.claimed_by
         WHERE i.family_id = $1 AND i.status = 'pending' AND i.expires_at >= now()
         ORDER BY i.claimed_at ASC`,
        [familyId],
      );
      await client.query("COMMIT");
      return result.rows.map((row) => ({
        claimedAt: row.claimed_at.toISOString(),
        displayName: row.display_name,
        expiresAt: row.expires_at.toISOString(),
        invitationId: row.invitation_id,
        telegramUserId: row.telegram_user_id,
        username: row.telegram_username,
      }));
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async approveInvitation(input) {
    const client = await database().connect();
    try {
      await client.query("BEGIN");

      // Candidate fields shown in HITL are rechecked against DB together with current owner role.
      await requireAdministrationSpace(client,input.familyId,input.approvedBy,input.space);
      const invitation = await client.query<{ candidate_id: string; status: string }>(
        `SELECT i.claimed_by AS candidate_id, i.status
         FROM invitations i
         JOIN users candidate ON candidate.id = i.claimed_by
         JOIN family_memberships approver
           ON approver.family_id = i.family_id
          AND approver.user_id = $2
          AND approver.role = 'owner'
         WHERE i.id = $1 AND i.family_id = $3
           AND candidate.telegram_user_id = $4
           AND candidate.display_name = $5
           AND (
             (i.status = 'pending' AND i.expires_at >= now()) OR
             (i.status = 'approved' AND i.decided_by = $2 AND i.decision_operation_key = $6)
           )
         FOR UPDATE OF i
         FOR SHARE OF approver`,
        [
          input.invitationId,
          input.approvedBy,
          input.familyId,
          input.candidateTelegramUserId,
          input.candidateDisplayName,
          input.operationKey,
        ],
      );
      const row = invitation.rows[0];
      if (!row) {
        throw new AppError(
          "AGENT_INVITATION_NOT_APPROVABLE",
          "Приглашение не найдено, истекло или данные кандидата изменились",
        );
      }
      if (row.status === "approved") {
        await client.query("COMMIT");
        return { approved: true };
      }

      // A user belongs to only one family; a conflicting grant fails without changing invitation state.
      const membership = await client.query<{ user_id: string }>(
        `INSERT INTO family_memberships (family_id, user_id, role)
         VALUES ($1, $2, 'member')
         ON CONFLICT (user_id) DO NOTHING
         RETURNING user_id`,
        [input.familyId, row.candidate_id],
      );
      if (!membership.rows[0]) {
        throw new AppError(
          "AGENT_INVITATION_NOT_APPROVABLE",
          "Кандидат уже состоит в другой семье",
        );
      }
      // Состав активного пространства заморожен, поэтому новому участнику выдаётся только личное:
      // прежняя семейная область остаётся со своим прежним кругом читателей.
      await provisionMemberPersonalSpace(client, {
        familyId: input.familyId,
        userId: membership.rows[0].user_id,
      });
      await client.query(
        `UPDATE invitations
         SET status = 'approved', decided_at = now(), decided_by = $2,
             decision_operation_key = $3
         WHERE id = $1 AND status = 'pending'`,
        [input.invitationId, input.approvedBy, input.operationKey],
      );
      await client.query(
        `INSERT INTO audit_events
           (family_id, actor_user_id, event_type, subject_id, metadata)
         VALUES ($1, $2, 'invitation.approved', $3,
                 jsonb_build_object('candidateTelegramUserId', $4::text,
                                    'operationKey', $5::text))`,
        [
          input.familyId,
          input.approvedBy,
          input.invitationId,
          input.candidateTelegramUserId,
          input.operationKey,
        ],
      );

      await client.query("COMMIT");
      return { approved: true };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async markInvitationDelivered(input) {
    const result = await database().query(
      `UPDATE invitations
       SET delivery_completed_at = COALESCE(delivery_completed_at, now())
       WHERE id = $1 AND family_id = $2 AND created_by = $3 AND operation_key = $4
         AND delivery_started_at IS NOT NULL`,
      [input.invitationId, input.familyId, input.createdBy, input.operationKey],
    );
    if (!result.rowCount) {
      throw invitationDeliveryAmbiguousError();
    }
  },

  async markInvitationDeliveryStarted(input) {
    const client = await database().connect();
    try {
      await client.query("BEGIN");

      // Session authorization is a snapshot; reserve transport only while owner access is live.
      const owner = await client.query(
        `SELECT 1
         FROM family_memberships
         WHERE family_id = $1 AND user_id = $2 AND role = 'owner'
         FOR SHARE`,
        [input.familyId, input.createdBy],
      );
      if (!owner.rowCount) {
        throw new AppError("AGENT_OWNER_REQUIRED", "Это действие доступно только владельцу");
      }

      // The row lock turns concurrent execution or replay into a durable fail-closed boundary.
      const invitation = await client.query<{
        delivery_completed_at: Date | null;
        delivery_started_at: Date | null;
        expires_at: Date;
        status: string;
      }>(
        `SELECT delivery_started_at, delivery_completed_at, expires_at, status
         FROM invitations
         WHERE id = $1 AND family_id = $2 AND created_by = $3 AND operation_key = $4
         FOR UPDATE`,
        [input.invitationId, input.familyId, input.createdBy, input.operationKey],
      );
      const row = invitation.rows[0];
      if (!row) {
        throw new AppError(
          "AGENT_INVITATION_DELIVERY_STATE_INVALID",
          "Не удалось подготовить отправку приглашения. Создайте новое приглашение",
        );
      }
      if (row.delivery_started_at !== null || row.delivery_completed_at !== null) {
        throw invitationDeliveryAmbiguousError();
      }
      if (row.status !== "open" || row.expires_at.getTime() <= Date.now()) {
        throw new AppError(
          "AGENT_INVITATION_EXPIRED",
          "Срок приглашения истек. Создайте новое приглашение",
        );
      }

      await client.query(
        `UPDATE invitations
         SET delivery_started_at = now()
         WHERE id = $1`,
        [input.invitationId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
};
