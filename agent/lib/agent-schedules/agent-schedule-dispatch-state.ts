/**
 * Atomic pre-handoff and post-receive state transitions for scheduled agent runs.
 *
 * Exports:
 * - `beginAgentScheduleDispatch`: binds the app session or terminalizes a revoked group run.
 * - `markAgentScheduleRunning`: binds Eve identity while tolerating an already-terminal event race.
 */
import type { PoolClient } from "pg";

import { AppError } from "../app-error.js";
import { database } from "../database.js";
import { isSpaceDestinationProven } from "../spaces/space-destination.js";

interface DispatchJobIdentity {
  id: string;
  leaseToken: string;
  runId: string;
}

/**
 * Аудитория чата доказывается заново перед передачей хода в Eve: между заведением расписания и
 * его сроком привязка чата к области меняется. Недоказанная аудитория приостанавливает запуск, а
 * не завершает расписание: `failClaim` терминален, повторяющееся расписание после него не
 * воскресает, а подтверждение состава случается при каждом входе человека в группу. Строка
 * запуска остаётся `claimed` без отметки отправки, поэтому то же самое вхождение переарендуется.
 */
async function holdUnprovenDestination(
  client: PoolClient,
  job: DispatchJobIdentity,
): Promise<boolean> {
  const row = (await client.query<{
    author_user_id: string; family_id: string; group_id: string | null;
    owner_user_id: string | null; space_id: string | null;
  }>(
    `SELECT author_user_id, family_id, group_id, owner_user_id, space_id FROM agent_schedules
      WHERE id = $1 AND status = 'leased' AND lease_token = $2 AND dispatch_started_at IS NULL`,
    [job.id, job.leaseToken],
  )).rows[0];
  // Пространство берётся раньше самой строки расписания: родитель блокируется прежде потомка.
  if (!row || await isSpaceDestinationProven(client, {
    familyId: row.family_id,
    groupId: row.group_id,
    spaceId: row.space_id,
    userId: row.group_id === null ? row.owner_user_id : row.author_user_id,
  })) return false;
  // Попытка возвращается: неподтверждённая аудитория не тратит бюджет безопасных повторов.
  const held = await client.query<{ repeated: boolean }>(
    `UPDATE agent_schedules
        SET status = 'active', attempts = greatest(attempts - 1, 0),
            lease_token = NULL, lease_expires_at = NULL, dispatch_started_at = NULL,
            last_error_code = 'AGENT_SCHEDULE_DESTINATION_UNPROVEN', updated_at = now()
      WHERE id = $1 AND status = 'leased' AND lease_token = $2
      RETURNING (last_error_code IS NOT DISTINCT FROM 'AGENT_SCHEDULE_DESTINATION_UNPROVEN') AS repeated`,
    [job.id, job.leaseToken],
  );
  if (!held.rows[0]) return false;
  if (!held.rows[0].repeated) {
    await client.query(
      `INSERT INTO audit_events (family_id, event_type, subject_id, metadata)
       VALUES ($1, 'agent_schedule.destination_held', $2,
               jsonb_build_object('code', 'AGENT_SCHEDULE_DESTINATION_UNPROVEN'))`,
      [row.family_id, job.id],
    );
  }
  return true;
}

export async function beginAgentScheduleDispatch(
  job: DispatchJobIdentity,
  input: { applicationSessionId: string },
): Promise<boolean> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    if (await holdUnprovenDestination(client, job)) {
      await client.query("COMMIT");
      return false;
    }
    const schedule = await client.query(
      `UPDATE agent_schedules SET dispatch_started_at = now(), updated_at = now()
        WHERE id = $1 AND status = 'leased' AND lease_token = $2
          AND dispatch_started_at IS NULL
          AND (scope <> 'group' OR (
            EXISTS (
              SELECT 1 FROM family_memberships
               WHERE family_id = agent_schedules.family_id
                 AND user_id = agent_schedules.author_user_id AND role = 'owner'
            ) AND EXISTS (
              SELECT 1 FROM telegram_groups
               WHERE id = agent_schedules.group_id
                 AND family_id = agent_schedules.family_id
                 AND telegram_chat_id = agent_schedules.telegram_chat_id
                 AND telegram_chat_type = agent_schedules.telegram_chat_type
                 AND type = 'external'
            )
          ))`,
      [job.id, job.leaseToken],
    );
    if (schedule.rowCount !== 1) {
      // A still-current group lease failed only its live authorization predicate.
      const revoked = await client.query<{ family_id: string }>(
        `UPDATE agent_schedules
            SET status = 'failed', lease_token = NULL, lease_expires_at = NULL,
                dispatch_started_at = NULL,
                last_error_code = 'AGENT_SCHEDULE_DESTINATION_REVOKED', updated_at = now()
          WHERE id = $1 AND status = 'leased' AND lease_token = $2
            AND dispatch_started_at IS NULL AND scope = 'group'
          RETURNING family_id`,
        [job.id, job.leaseToken],
      );
      if (!revoked.rows[0]) {
        throw new AppError("AGENT_SCHEDULE_LEASE_STALE", "Запуск расписания уже неактуален");
      }
      await client.query(
        `UPDATE agent_schedule_runs
            SET status = 'failed', error_code = 'AGENT_SCHEDULE_DESTINATION_REVOKED',
                completed_at = now(), updated_at = now()
          WHERE id = $1 AND schedule_id = $2 AND lease_token = $3 AND status = 'claimed'`,
        [job.runId, job.id, job.leaseToken],
      );
      await client.query("DELETE FROM agent_schedule_history_snapshots WHERE run_id = $1", [job.runId]);
      await client.query(
        `INSERT INTO audit_events (family_id, event_type, subject_id, metadata)
         VALUES ($1, 'agent_schedule.failed', $2,
                 jsonb_build_object('code', 'AGENT_SCHEDULE_DESTINATION_REVOKED'))`,
        [revoked.rows[0].family_id, job.id],
      );
      await client.query("COMMIT");
      return false;
    }

    const run = await client.query(
      `UPDATE agent_schedule_runs
          SET status = 'dispatching', dispatch_started_at = now(),
              application_session_id = $4, updated_at = now()
        WHERE id = $1 AND schedule_id = $2 AND lease_token = $3 AND status = 'claimed'`,
      [job.runId, job.id, job.leaseToken, input.applicationSessionId],
    );
    if (run.rowCount !== 1) {
      throw new AppError("AGENT_SCHEDULE_LEASE_STALE", "Запуск расписания уже неактуален");
    }
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function markAgentScheduleRunning(
  job: DispatchJobIdentity,
  input: { applicationSessionId: string; eveSessionId: string },
): Promise<void> {
  const result = await database().query(
    `UPDATE agent_schedule_runs
        SET status = 'running', eve_session_id = $5, updated_at = now()
      WHERE id = $1 AND schedule_id = $2 AND lease_token = $3 AND status = 'dispatching'
        AND application_session_id = $4`,
    [job.runId, job.id, job.leaseToken, input.applicationSessionId, input.eveSessionId],
  );
  if (result.rowCount === 1) return;
  // A finished run, or this very marker committed before its acknowledgement was lost, is not stale.
  const terminal = await database().query(
    `SELECT 1 FROM agent_schedule_runs
      WHERE id = $1 AND schedule_id = $2 AND lease_token = $3
        AND application_session_id = $4
        AND (status IN ('completed', 'failed', 'ambiguous') OR (status = 'running' AND eve_session_id = $5))`,
    [job.runId, job.id, job.leaseToken, input.applicationSessionId, input.eveSessionId],
  );
  if (terminal.rowCount !== 1) {
    throw new AppError("AGENT_SCHEDULE_LEASE_STALE", "Запуск расписания уже неактуален");
  }
}
