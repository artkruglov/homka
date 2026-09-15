/**
 * PostgreSQL Workflow physical session retention adapter.
 *
 * Exports:
 * - `deletePostgresEveSession`: atomically deletes one verified terminal run via a query client.
 * - `deleteConfiguredPostgresEveSession`: fail-fast environment boundary for scheduled retention.
 *
 * Invariants:
 * - Table names come from the pinned package's public exported schema.
 * - The run row is locked and removed last; any failure rolls the transaction back.
 * - A hook whose token-retention window is still open blocks deletion; Workflow itself treats an
 *   absent or past window as ended.
 * - A run parked for an hour on a retired conversation is cancelled before deletion.
 */
import pg from "pg";

import { AppError } from "../app-error.js";

const { Client } = pg;
const EVE_RUN_ID_PATTERN = /^wrun_[A-Z0-9]{26}$/u;
const TERMINAL_RUN_STATUSES = new Set(["cancelled", "completed", "failed"]);
// A run untouched for this long, whose conversation was retired a day earlier, is parked for good.
const PARKED_RUN_IDLE_INTERVAL = "1 hour";

interface WorkflowQueryClient {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rowCount: number | null; rows: Array<Record<string, unknown>> }>;
}

export async function deletePostgresEveSession(
  runId: string,
  client: WorkflowQueryClient,
): Promise<void> {
  if (!EVE_RUN_ID_PATTERN.test(runId)) {
    throw new AppError(
      "AGENT_EVE_SESSION_ID_INVALID",
      "Идентификатор удаляемой Eve-сессии некорректен",
    );
  }

  await client.query("BEGIN");
  try {
    // Lock the primary row before proving that application retirement cannot race active Workflow.
    const run = await client.query(
      `SELECT status::text AS status, updated_at <= now() - $2::interval AS parked
         FROM workflow.workflow_runs WHERE id = $1 FOR UPDATE`,
      [runId, PARKED_RUN_IDLE_INTERVAL],
    );
    const status = run.rows[0]?.status;
    if (typeof status !== "string") {
      throw new AppError(
        "AGENT_EVE_SESSION_STORAGE_MISSING",
        `Не найдены данные удаляемой Eve-сессии ${runId}`,
      );
    }
    if (!TERMINAL_RUN_STATUSES.has(status)) {
      // An Eve session run parks on a hook and stays `running` forever (upstream 63d7e65). The
      // caller only reaches here for a conversation retired a day earlier without a pending
      // operation, so a run idle since then will never be answered and is closed here.
      if (run.rows[0]?.parked !== true) {
        throw new AppError(
          "AGENT_EVE_SESSION_STORAGE_ACTIVE",
          `Eve-сессия ${runId} ещё выполняется и не может быть удалена`,
        );
      }
      await client.query(
        `UPDATE workflow.workflow_runs
            SET status = 'cancelled', completed_at = coalesce(completed_at, now()), updated_at = now()
          WHERE id = $1`,
        [runId],
      );
    }

    // Hooks carry externally reusable tokens, so an open retention window still blocks deletion.
    // An absent or past window is exactly what Workflow treats as ended.
    const hook = await client.query(
      `SELECT EXISTS (
         SELECT 1 FROM workflow.workflow_hooks
          WHERE run_id = $1 AND token_retention_until IS NOT NULL AND token_retention_until > now()
       ) AS exists`,
      [runId],
    );
    if (hook.rows[0]?.exists === true) {
      throw new AppError(
        "AGENT_EVE_SESSION_HOOK_RETENTION_ACTIVE",
        `Eve-сессия ${runId} ещё содержит защищённые Workflow hooks`,
      );
    }

    // Public schema has no foreign keys, so remove every per-run projection before the run itself.
    for (const statement of [
      "DELETE FROM workflow.workflow_stream_chunks WHERE run_id = $1",
      "DELETE FROM workflow.workflow_waits WHERE run_id = $1",
      "DELETE FROM workflow.workflow_hooks WHERE run_id = $1",
      "DELETE FROM workflow.workflow_steps WHERE run_id = $1",
      "DELETE FROM workflow.workflow_events WHERE run_id = $1",
      "DELETE FROM workflow.workflow_event_slots WHERE run_id = $1",
    ]) {
      await client.query(statement, [runId]);
    }
    const deletedRun = await client.query(
      "DELETE FROM workflow.workflow_runs WHERE id = $1",
      [runId],
    );
    if (deletedRun.rowCount !== 1) {
      throw new AppError(
        "AGENT_EVE_SESSION_STORAGE_DELETE_INCOMPLETE",
        `Не удалось удалить данные Eve-сессии ${runId}`,
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function deleteConfiguredPostgresEveSession(runId: string): Promise<void> {
  const connectionString = process.env.WORKFLOW_POSTGRES_URL;
  if (!connectionString) {
    throw new AppError(
      "AGENT_WORKFLOW_DATABASE_CONFIG_MISSING",
      "Не задано подключение к базе Workflow",
    );
  }

  // A short-lived client keeps the retention job independent from the world worker's pool lifecycle.
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await deletePostgresEveSession(runId, client);
  } finally {
    await client.end();
  }
}
