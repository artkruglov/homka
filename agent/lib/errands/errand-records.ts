/** Identity-bound reads: a recipient sees only a disclosed result, never the initiator's query. */
import type { PoolClient } from "pg";
import { AppError } from "../app-error.js";
import type { ErrandState } from "./errand-contract.js";

export interface ErrandRow {
  id: string; family_id: string; initiator_user_id: string; recipient_user_id: string;
  space_id: string | null; brief: string; state: ErrandState; version: number;
  result_version: number; delivery_authorized: boolean; diagnostic_code: string | null;
}
export interface ErrandView {
  id: string; state: ErrandState; version: number; resultVersion: number;
  initiator: string; recipient: string; brief?: string;
  result: { text: string; sources: unknown } | null;
  answers: { text: string; resultVersion: number; sharedAt: string }[];
  diagnosticCode: string | null;
  researchState?: "started" | "completed" | "ambiguous" | null;
}

export function errandDenied(): never {
  throw new AppError("AGENT_ERRAND_ACCESS_DENIED", "Поручение или действие недоступно в этом личном чате");
}

export async function readErrand(
  client: PoolClient, familyId: string, userId: string, id: string, lock = false,
): Promise<ErrandRow> {
  const row = (await client.query<ErrandRow>(
    `SELECT e.* FROM errands e WHERE e.id=$1 AND e.family_id=$2 AND (
      e.initiator_user_id=$3 OR (e.recipient_user_id=$3 AND EXISTS (
        SELECT 1 FROM errand_deliveries d WHERE d.errand_id=e.id AND d.result_version=e.result_version
          AND d.state IN ('sending','sent','ambiguous')))) ${lock ? "FOR UPDATE OF e" : ""}`,
    [id, familyId, userId],
  )).rows[0];
  if (!row) errandDenied();
  return row;
}

export async function presentErrand(client: PoolClient, row: ErrandRow, userId: string): Promise<ErrandView> {
  const researchState = row.initiator_user_id === userId
    ? (await client.query<{state:"started"|"completed"|"ambiguous"}>(
      "SELECT state FROM errand_research_runs WHERE errand_id=$1 ORDER BY input_version DESC LIMIT 1",[row.id])).rows[0]?.state ?? null
    : undefined;
  const names = (await client.query<{ initiator: string; recipient: string }>(
    `SELECT a.display_name AS initiator,b.display_name AS recipient FROM users a,users b
      WHERE a.id=$1 AND b.id=$2`, [row.initiator_user_id, row.recipient_user_id],
  )).rows[0]!;
  const result = (await client.query<{ text: string; sources: unknown }>(
    "SELECT text,sources FROM errand_results WHERE errand_id=$1 AND result_version=$2",
    [row.id, row.result_version],
  )).rows[0] ?? null;
  const answers = (await client.query<{ text: string; result_version: number; created_at: Date }>(
    "SELECT text,result_version,created_at FROM errand_answers WHERE errand_id=$1 ORDER BY created_at,id LIMIT 100",
    [row.id],
  )).rows.map(answer => ({ text: answer.text, resultVersion: answer.result_version, sharedAt: answer.created_at.toISOString() }));
  return {
    id: row.id, state: row.state, version: row.version, resultVersion: row.result_version,
    ...names, ...(row.initiator_user_id === userId ? { brief: row.brief } : {}),
    result, answers, diagnosticCode: row.diagnostic_code,
    ...(researchState === undefined ? {} : {researchState}),
  };
}
