/**
 * Закрытый откат схемы: что обязано быть подавлено до старта воркеров.
 *
 * Экспорт:
 * - `ClosedRollbackReport`: сигналы, которые сработают сами, если их не снять.
 * - `verifyClosedRollback`: read-only проверка восстановленной копии.
 * - `suppressAfterRestore`: снимает ровно эти сигналы.
 *
 * Восстановление дампа возвращает не только данные, но и очередь Telegram, просроченные
 * напоминания и расписания и живые сессии. Всё это сработает лавиной при первом же запуске:
 * человек получит поток старых уведомлений и ответы на вопросы, заданные до отката. Отправленные
 * сообщения при этом не отзываются, поэтому подавление обязано идти до старта воркеров, а не
 * после первой жалобы.
 */
import type { PoolClient } from "pg";

export interface ClosedRollbackReport {
  readonly blockers: string[];
  readonly dueReminders: number;
  readonly dueSchedules: number;
  readonly liveSessions: number;
  readonly pendingApprovals: number;
  readonly queuedUpdates: number;
}

async function count(client: PoolClient, sql: string, values: unknown[] = []): Promise<number> {
  const result = await client.query<{ count: string }>(sql, values);
  return Number(result.rows[0]?.count ?? "0");
}

export async function verifyClosedRollback(
  client: PoolClient,
  now: Date,
): Promise<ClosedRollbackReport> {
  const queuedUpdates = await count(
    client,
    "SELECT count(*)::text AS count FROM telegram_ingress_updates WHERE status IN ('pending','processing')",
  );
  const dueReminders = await count(
    client,
    "SELECT count(*)::text AS count FROM reminders WHERE status IN ('active','leased') AND available_at <= $1",
    [now],
  );
  const dueSchedules = await count(
    client,
    "SELECT count(*)::text AS count FROM agent_schedules WHERE status IN ('active','leased') AND next_run_at <= $1",
    [now],
  );
  const liveSessions = await count(
    client,
    "SELECT count(*)::text AS count FROM conversation_sessions WHERE retired_at IS NULL",
  );
  const pendingApprovals = await count(
    client,
    "SELECT count(*)::text AS count FROM telegram_hitl_approvals WHERE consumed_at IS NULL",
  );
  const blockers: string[] = [];
  if (queuedUpdates > 0) blockers.push("AGENT_ROLLBACK_INGRESS_QUEUE_NOT_EMPTY");
  if (dueReminders > 0) blockers.push("AGENT_ROLLBACK_REMINDERS_DUE");
  if (dueSchedules > 0) blockers.push("AGENT_ROLLBACK_SCHEDULES_DUE");
  if (liveSessions > 0) blockers.push("AGENT_ROLLBACK_SESSIONS_LIVE");
  if (pendingApprovals > 0) blockers.push("AGENT_ROLLBACK_APPROVALS_PENDING");
  return { blockers, dueReminders, dueSchedules, liveSessions, pendingApprovals, queuedUpdates };
}

/**
 * Просроченное напоминание не «догоняет» человека после отката: оно приостанавливается, а не
 * завершается, потому что его ещё может понадобиться перенести. Расписание ведёт себя так же.
 */
export async function suppressAfterRestore(
  client: PoolClient,
  now: Date,
): Promise<ClosedRollbackReport> {
  await client.query(
    "DELETE FROM telegram_ingress_updates WHERE status IN ('pending','processing')",
  );
  await client.query(
    `UPDATE reminders SET status = 'paused', lease_token = NULL, lease_expires_at = NULL,
        dispatch_started_at = NULL, last_error_code = 'AGENT_ROLLBACK_SUPPRESSED', updated_at = $1
      WHERE status IN ('active','leased') AND available_at <= $1`,
    [now],
  );
  await client.query(
    `UPDATE agent_schedules SET status = 'paused', lease_token = NULL, lease_expires_at = NULL,
        dispatch_started_at = NULL, last_error_code = 'AGENT_ROLLBACK_SUPPRESSED', updated_at = $1
      WHERE status IN ('active','leased') AND next_run_at <= $1`,
    [now],
  );
  await client.query("DELETE FROM telegram_hitl_approvals WHERE consumed_at IS NULL");
  await client.query(
    `UPDATE conversation_sessions SET retired_at = $1, pending_operation = false
      WHERE retired_at IS NULL`,
    [now],
  );
  await client.query(
    `DELETE FROM conversation_session_routes AS route
      USING conversation_sessions AS session
      WHERE session.id = route.session_id AND session.retired_at IS NOT NULL`,
  );
  return await verifyClosedRollback(client, now);
}
