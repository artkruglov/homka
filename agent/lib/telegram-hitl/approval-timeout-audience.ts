/** Select a bounded timeout batch and lock its audiences before any session/approval row. */
import type { PoolClient } from "pg";

/**
 * Кандидатов берём с запасом. Пропущенная по `SKIP LOCKED` область не даёт строке ни лизы, ни
 * увеличения счётчика попыток, поэтому в следующий раз она снова окажется первой в очереди: без
 * запаса одна заблокированная область заняла бы собой всю партию и заморозила бы развёртку
 * подтверждений во всех остальных. Запас ограничен, чтобы одна долгая блокировка не превращала
 * минутную чистку в полный скан.
 */
const CANDIDATE_OVERFETCH = 4;

export async function lockTimeoutAudiences(client: PoolClient, now: Date, timeoutMilliseconds: number, limit: number) {
  const candidates = await client.query<{ id: string; space_id: string | null; space_policy_version: number | null }>(
    `SELECT a.id,s.space_id,s.space_policy_version FROM telegram_hitl_approvals a
       JOIN conversation_sessions s ON s.id=a.application_session_id
     WHERE a.consumed_at IS NULL AND a.request_kind IN ('question','tool-approval')
       AND a.created_at <= $1::timestamptz - ($2::bigint * interval '1 millisecond')
       AND (a.timeout_lease_expires_at IS NULL OR a.timeout_lease_expires_at <= $1)
       AND s.eve_session_id=a.eve_session_id AND s.retired_at IS NULL AND s.pending_operation
     ORDER BY a.timeout_attempts,a.created_at,a.id LIMIT $3`, [now,timeoutMilliseconds,limit*CANDIDATE_OVERFETCH],
  );
  const locked = await client.query<{ id: string }>(
    `SELECT id FROM spaces WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE SKIP LOCKED`,
    // Прежняя история несёт space_id от бэкфилла без версии политики: её аудиторией
    // никто не управляет, поэтому блокировать по ней нечего.
    [candidates.rows.flatMap((row) => row.space_policy_version !== null && row.space_id ? [row.space_id] : [])],
  );
  return { approvalIds: candidates.rows.map((row) => row.id), spaceIds: locked.rows.map((row) => row.id) };
}
