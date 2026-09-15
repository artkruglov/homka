/**
 * Разведка копии рабочей базы ПЕРЕД миграцией 103.
 *
 * Экспорт:
 * - `LegacySpacePreflight`: отчёт о строках, из-за которых перенос откажется целиком.
 * - `preflightLegacySpaces`: read-only проверка, не требующая применённых 103-106.
 *
 * Снимок 103 создаёт личные пространства только из текущего `family_memberships`, а бэкфилл 104
 * отказывается целиком, если хотя бы одна строка не получила аудиторию. Найти такие строки заранее
 * дешевле, чем получить отказ на проде.
 */
import type { PoolClient } from "pg";

import { legacyAuditCatalog } from "./legacy-space-audit-catalog.js";

export interface LegacySpaceTableFinding { table: string; rows: number }
export interface LegacySpacePreflight {
  blockers: string[];
  notes: string[];
  personalRowsWithoutCurrentMember: LegacySpaceTableFinding[];
  taskPlansWithoutKnownUser: number;
  truncatedGroupTitles: number;
  unclassifiedRelations: string[];
}

/** Длина названия, которую принимает `spaces.title`; Telegram допускает более длинное. */
const SPACE_TITLE_LIMIT = 100;

function identifier(value: string): string {
  if (!/^[a-z_][a-z_0-9]*$/u.test(value)) throw new Error("Invalid discovered relation name");
  return `"${value}"`;
}

async function personalRowsWithoutCurrentMember(client: PoolClient): Promise<LegacySpaceTableFinding[]> {
  // Колонка владельца обнаруживается в каталоге базы, а не задаётся списком: новая таблица с тем же
  // разделением попадает под проверку сама.
  const candidates = await client.query<{ table_name: string; owner_column: string }>(
    `SELECT c.table_name, c.column_name AS owner_column
       FROM information_schema.columns c
      WHERE c.table_schema = current_schema()
        AND c.column_name IN ('owner_user_id', 'scope_partition_key')
        AND EXISTS (
          SELECT 1 FROM information_schema.columns s
           WHERE s.table_schema = c.table_schema AND s.table_name = c.table_name AND s.column_name = 'scope'
        )
        AND EXISTS (
          SELECT 1 FROM information_schema.columns f
           WHERE f.table_schema = c.table_schema AND f.table_name = c.table_name AND f.column_name = 'family_id'
        )
        AND EXISTS (
          SELECT 1 FROM information_schema.tables t
           WHERE t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
        )
      ORDER BY c.table_name, c.column_name`,
  );
  const findings: LegacySpaceTableFinding[] = [];
  for (const candidate of candidates.rows) {
    const result = await client.query<{ rows: string }>(
      `SELECT count(*)::text AS rows FROM ${identifier(candidate.table_name)} x
        WHERE x.scope = 'personal' AND x.${identifier(candidate.owner_column)} IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM family_memberships m
             WHERE m.family_id = x.family_id AND m.user_id = x.${identifier(candidate.owner_column)}
          )`,
    );
    const rows = Number(result.rows[0]?.rows ?? "0");
    if (rows > 0) findings.push({ table: candidate.table_name, rows });
  }
  return findings;
}

export async function preflightLegacySpaces(client: PoolClient): Promise<LegacySpacePreflight> {
  const relations = (await client.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name <> 'schema_migrations'`,
  )).rows.map((row) => row.table_name);
  // Только лишние отношения: те, что создаёт сама 103, до неё отсутствуют законно.
  const unclassifiedRelations = relations.filter((name) => legacyAuditCatalog[name] === undefined).sort();

  const truncatedGroupTitles = Number((await client.query<{ rows: string }>(
    "SELECT count(*)::text AS rows FROM telegram_groups WHERE char_length(title) > $1",
    [SPACE_TITLE_LIMIT],
  )).rows[0]!.rows);

  const taskPlansWithoutKnownUser = Number((await client.query<{ rows: string }>(
    `SELECT count(*)::text AS rows FROM shared_task_plans p
      WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.telegram_user_id = p.telegram_user_id)`,
  )).rows[0]!.rows);

  const personalRows = await personalRowsWithoutCurrentMember(client);

  const blockers: string[] = [];
  if (unclassifiedRelations.length) blockers.push("AGENT_SPACE_PREFLIGHT_UNCLASSIFIED_RELATIONS");
  if (taskPlansWithoutKnownUser > 0) blockers.push("AGENT_SPACE_PREFLIGHT_PLAN_WITHOUT_AUDIENCE");
  for (const finding of personalRows) {
    blockers.push(`AGENT_SPACE_PREFLIGHT_PERSONAL_WITHOUT_AUDIENCE:${finding.table}`);
  }
  const notes: string[] = [];
  if (truncatedGroupTitles > 0) notes.push("AGENT_SPACE_PREFLIGHT_TITLE_TRUNCATED");

  return {
    blockers,
    notes,
    personalRowsWithoutCurrentMember: personalRows,
    taskPlansWithoutKnownUser,
    truncatedGroupTitles,
    unclassifiedRelations,
  };
}
