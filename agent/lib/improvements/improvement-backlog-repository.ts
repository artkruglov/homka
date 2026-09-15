/**
 * Durable improvement backlog per family.
 *
 * Export:
 * - `improvementBacklogRepository`: `record` (upsert by fingerprint, recurrence + evidence),
 *   `list` (open items ranked by priority, recurrence, recency), `close` (done / dismissed).
 */
import { AppError } from "../app-error.js";
import { database } from "../database.js";
import type { ImprovementCategory } from "./turn-evidence.js";

export type ImprovementPriority = "high" | "low" | "medium";
export type ImprovementStatus = "dismissed" | "done" | "open";

export interface ImprovementItemInput {
  category: ImprovementCategory;
  evidence: Record<string, unknown>;
  familyId: string;
  fingerprint: string;
  priority: ImprovementPriority;
  summary: string;
}

export interface ImprovementItem {
  category: ImprovementCategory;
  evidence: Record<string, unknown>;
  firstSeenAt: string;
  id: string;
  lastSeenAt: string;
  priority: ImprovementPriority;
  recurrenceCount: number;
  status: ImprovementStatus;
  summary: string;
}

interface ItemRow {
  category: ImprovementCategory;
  evidence: Record<string, unknown>;
  first_seen_at: Date;
  id: string;
  last_seen_at: Date;
  priority: ImprovementPriority;
  recurrence_count: number;
  status: ImprovementStatus;
  summary: string;
}

const PRIORITY_RANK: Record<ImprovementPriority, number> = { high: 0, low: 2, medium: 1 };
export const IMPROVEMENT_LIST_LIMIT = 20;

function rowToItem(row: ItemRow): ImprovementItem {
  return {
    category: row.category,
    evidence: row.evidence,
    firstSeenAt: row.first_seen_at.toISOString(),
    id: row.id,
    lastSeenAt: row.last_seen_at.toISOString(),
    priority: row.priority,
    recurrenceCount: row.recurrence_count,
    status: row.status,
    summary: row.summary,
  };
}

export const improvementBacklogRepository = {
  /** Inserts a new open item or bumps the recurrence of the open item with the same fingerprint. */
  async record(input: ImprovementItemInput): Promise<{ item: ImprovementItem; recurred: boolean }> {
    const result = await database().query<ItemRow & { recurred: boolean }>(
      `INSERT INTO agent_improvement_items
         (family_id, fingerprint, category, summary, priority, evidence)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT (family_id, fingerprint) WHERE status = 'open' AND legacy_quarantined_at IS NULL DO UPDATE
         SET recurrence_count = agent_improvement_items.recurrence_count + 1,
             last_seen_at = now(),
             evidence = $6::jsonb,
             -- A recurring problem keeps the higher priority it was ever given.
             priority = CASE
               WHEN agent_improvement_items.priority = 'high' OR EXCLUDED.priority = 'high' THEN 'high'
               WHEN agent_improvement_items.priority = 'medium' OR EXCLUDED.priority = 'medium' THEN 'medium'
               ELSE 'low' END
       RETURNING id, category, summary, priority, evidence, recurrence_count, status,
                 first_seen_at, last_seen_at, (xmax <> 0) AS recurred`,
      [input.familyId, input.fingerprint, input.category, input.summary, input.priority,
        JSON.stringify(input.evidence)],
    );
    const row = result.rows[0];
    if (!row) throw new AppError("AGENT_IMPROVEMENT_WRITE_FAILED", "Не удалось сохранить пункт бэклога");
    return { item: rowToItem(row), recurred: row.recurred };
  },

  async list(familyId: string, status: ImprovementStatus = "open"): Promise<ImprovementItem[]> {
    const result = await database().query<ItemRow>(
      `SELECT id, category, summary, priority, evidence, recurrence_count, status,
              first_seen_at, last_seen_at
         FROM agent_improvement_items
        WHERE family_id = $1 AND status = $2 AND legacy_quarantined_at IS NULL
        ORDER BY last_seen_at DESC
        LIMIT 200`,
      [familyId, status],
    );
    return result.rows
      .map(rowToItem)
      .sort((a, b) =>
        PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
        b.recurrenceCount - a.recurrenceCount ||
        b.lastSeenAt.localeCompare(a.lastSeenAt)
      )
      .slice(0, IMPROVEMENT_LIST_LIMIT);
  },

  async close(input: {
    closedByUserId: string | null;
    familyId: string;
    id: string;
    status: "dismissed" | "done";
  }): Promise<ImprovementItem> {
    const result = await database().query<ItemRow>(
      `UPDATE agent_improvement_items
          SET status = $3, closed_at = now(), closed_by_user_id = $4
        WHERE id = $1 AND family_id = $2 AND status = 'open' AND legacy_quarantined_at IS NULL
        RETURNING id, category, summary, priority, evidence, recurrence_count, status,
                  first_seen_at, last_seen_at`,
      [input.id, input.familyId, input.status, input.closedByUserId],
    );
    const row = result.rows[0];
    if (!row) throw new AppError("AGENT_IMPROVEMENT_NOT_FOUND", "Открытый пункт с таким id не найден");
    return rowToItem(row);
  },
};
