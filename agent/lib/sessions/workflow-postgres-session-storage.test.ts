/**
 * PostgreSQL Workflow session retention adapter tests.
 *
 * Tests:
 * - Rejects malformed and absent Eve run identities.
 * - Refuses a run still being worked on and a hook whose retention window is still open.
 * - Cancels a run parked long after the application retired its conversation, then deletes it.
 * - Deletes every public per-run table atomically before the run row.
 * - Takes the session's turn runs with it, and sweeps the ones whose session is already gone.
 * - Rolls back and preserves the original database failure.
 */
import { describe, expect, it, vi } from "vitest";

import {
  deleteOrphanedPostgresEveRuns,
  deletePostgresEveSession,
} from "./workflow-postgres-session-storage.js";

const runId = "wrun_01M0AZKZAKTGSH4QQZBBCJK63C";

function clientWithRows(rows: Array<Record<string, unknown>[]>) {
  const query = vi.fn(async (_text: string, _values?: readonly unknown[]) => ({
    rowCount: 1,
    rows: rows.shift() ?? [],
  }));
  return { query };
}

describe("deletePostgresEveSession", () => {
  it("rejects a malformed run id before querying PostgreSQL", async () => {
    const client = clientWithRows([]);

    await expect(deletePostgresEveSession("session-1", client)).rejects.toThrowError(
      /AGENT_EVE_SESSION_ID_INVALID/u,
    );
    expect(client.query).not.toHaveBeenCalled();
  });

  it("requires an existing terminal run without retained hooks", async () => {
    const missing = clientWithRows([[], []]);
    await expect(deletePostgresEveSession(runId, missing)).rejects.toThrowError(
      /AGENT_EVE_SESSION_STORAGE_MISSING/u,
    );
    expect(missing.query).toHaveBeenLastCalledWith("ROLLBACK");

    const active = clientWithRows([[], [{ parked: false, status: "running" }], []]);
    await expect(deletePostgresEveSession(runId, active)).rejects.toThrowError(
      /AGENT_EVE_SESSION_STORAGE_ACTIVE/u,
    );
    expect(active.query).toHaveBeenLastCalledWith("ROLLBACK");

    const retainedHook = clientWithRows([
      [], [{ parked: true, status: "completed" }], [], [{ exists: true }], [],
    ]);
    await expect(deletePostgresEveSession(runId, retainedHook)).rejects.toThrowError(
      /AGENT_EVE_SESSION_HOOK_RETENTION_ACTIVE/u,
    );
    expect(retainedHook.query).toHaveBeenLastCalledWith("ROLLBACK");
  });

  // Upstream 63d7e65: an Eve session run parks on a hook and never leaves `running`. The
  // application retired that conversation a day earlier, so nobody will answer the hook; refusing
  // to delete kept the run and its whole event log forever, re-read on every agent start.
  it("cancels a run left parked after its conversation was retired", async () => {
    const client = clientWithRows([
      [], [{ parked: true, status: "running" }], [], [], [{ exists: false }],
    ]);

    await expect(deletePostgresEveSession(runId, client)).resolves.toBeUndefined();

    const statements = client.query.mock.calls.map(([sql]) => sql);
    expect(statements[2]).toMatch(/UPDATE workflow\.workflow_runs\s+SET status = 'cancelled'/u);
    // Only an open retention window protects a hook; a parked session's hooks carry none.
    expect(statements.some((sql) => /token_retention_until > now\(\)/u.test(sql))).toBe(true);
    expect(statements).toContain("DELETE FROM workflow.workflow_runs WHERE id = $1");
    expect(statements.at(-1)).toBe("COMMIT");
  });

  it("deletes all public per-run records in one transaction", async () => {
    const client = clientWithRows([[], [{ parked: true, status: "failed" }], [], [{ exists: false }]]);

    await expect(deletePostgresEveSession(runId, client)).resolves.toBeUndefined();

    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN",
      expect.stringContaining("FROM workflow.workflow_runs"),
      expect.stringContaining("$rootRunId"),
      expect.stringContaining("FROM workflow.workflow_hooks"),
      "DELETE FROM workflow.workflow_stream_chunks WHERE run_id = ANY($1)",
      "DELETE FROM workflow.workflow_waits WHERE run_id = ANY($1)",
      "DELETE FROM workflow.workflow_hooks WHERE run_id = ANY($1)",
      "DELETE FROM workflow.workflow_steps WHERE run_id = ANY($1)",
      "DELETE FROM workflow.workflow_events WHERE run_id = ANY($1)",
      "DELETE FROM workflow.workflow_event_slots WHERE run_id = ANY($1)",
      "DELETE FROM workflow.workflow_runs WHERE id = $1",
      "COMMIT",
    ]);
  });

  it("takes the turn runs of the session with it", async () => {
    // Каждый ход это отдельный run со своим журналом: без этого на проде осталось 6829 событий
    // из 9211 от ходов уже удалённых сессий.
    const child = "wrun_01M0AZKZAKTGSH4QQZBBCJK64D";
    const client = clientWithRows([
      [], [{ parked: true, status: "completed" }], [{ id: child }], [{ exists: false }],
    ]);

    await expect(deletePostgresEveSession(runId, client)).resolves.toBeUndefined();

    const projections = client.query.mock.calls
      .filter(([sql]) => sql.startsWith("DELETE FROM workflow.workflow_events"));
    expect(projections[0]![1]).toEqual([[runId, child]]);
    expect(client.query.mock.calls.map(([sql]) => sql)).toContain(
      "DELETE FROM workflow.workflow_runs WHERE id = ANY($1) AND id <> $2");
    // Незавершённый ход удаляемой сессии закрывается: продолжать его уже некуда.
    expect(client.query.mock.calls.some(([sql]) => sql.includes("SET status = 'cancelled'")))
      .toBe(true);
  });

  it("rolls back and rethrows the original deletion error", async () => {
    const databaseError = new Error("connection lost");
    const query = vi.fn()
      .mockResolvedValueOnce({ rowCount: null, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ status: "cancelled" }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ exists: false }] })
      .mockRejectedValueOnce(databaseError)
      .mockResolvedValueOnce({ rowCount: null, rows: [] });

    await expect(deletePostgresEveSession(runId, { query })).rejects.toBe(databaseError);
    expect(query).toHaveBeenLastCalledWith("ROLLBACK");
  });
});

describe("deleteOrphanedPostgresEveRuns", () => {
  it("removes only terminal turn runs whose session row is gone", async () => {
    const orphan = "wrun_01M0AZKZAKTGSH4QQZBBCJK65E";
    const client = clientWithRows([[], [{ id: orphan }]]);

    await expect(deleteOrphanedPostgresEveRuns(client)).resolves.toBe(1);

    const [, select] = client.query.mock.calls[1]!;
    expect(client.query.mock.calls[1]![0]).toContain("p.id IS NULL");
    expect(client.query.mock.calls[1]![0]).toContain("'cancelled', 'completed', 'failed'");
    expect(select).toEqual(["1 hour", 200]);
    expect(client.query.mock.calls.map(([sql]) => sql)).toContain(
      "DELETE FROM workflow.workflow_runs WHERE id = ANY($1)");
    expect(client.query.mock.calls.at(-1)![0]).toBe("COMMIT");
  });

  it("commits without deleting anything when nothing is orphaned", async () => {
    const client = clientWithRows([[], []]);

    await expect(deleteOrphanedPostgresEveRuns(client)).resolves.toBe(0);

    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN",
      expect.stringContaining("$rootRunId"),
      "COMMIT",
    ]);
  });
});
