/**
 * Привязка строк таблиц, появившихся после замороженного переноса 104.
 *
 * Экспорт:
 * - `bindLateSpaceRecords`: проставляет область строкам, у которых её ещё нет.
 *
 * Перенос 104 заморожен намеренно: он обязан выдавать один и тот же результат на любой копии, и
 * поздние правки каталога не должны менять его поведение. Но таблицы продолжают появляться, и
 * каждая новая, пока семья живёт в прежнем режиме, копит строки без области. Ворота перехода
 * требуют, чтобы несвязанных строк не осталось, поэтому у поздних таблиц должен быть свой проход.
 *
 * Правило области берётся из живого каталога переноса — того же, по которому считает аудит, —
 * поэтому «чем связываем» и «что проверяем перед переходом» не могут разойтись. Проход
 * идемпотентен и чужую область не переписывает: обновляются только строки с `NULL`.
 */
import type { PoolClient } from "pg";

import { legacyAuditCatalog as frozenCatalog } from "../../../scripts/migration-data/space-records-104-catalog.ts";
import { legacyAuditCatalog } from "./legacy-space-audit-catalog.js";
import { legacyBoundaryQuery } from "./legacy-space-audit.js";

export interface LateBindingReport {
  readonly tables: Readonly<Record<string, number>>;
  readonly updatedRows: number;
}

function identifier(value: string): string {
  if (!/^[a-z_][a-z_0-9]*$/u.test(value)) {
    throw new Error("AGENT_SPACE_LATE_BINDING_IDENTIFIER_INVALID");
  }
  return `"${value}"`;
}

/** Таблицы живого каталога, которых не было в замороженном, и которые несут собственную область. */
async function lateBoundTables(client: PoolClient, schema: string): Promise<string[]> {
  const withBinding = new Set((await client.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.columns
      WHERE table_schema = $1 AND column_name = 'space_id'`, [schema],
  )).rows.map((row) => row.table_name));
  return Object.entries(legacyAuditCatalog)
    .filter(([table, rule]) => rule.action === "map"
      && !Object.hasOwn(frozenCatalog, table)
      && withBinding.has(table))
    .map(([table]) => table)
    .sort();
}

export async function bindLateSpaceRecords(client: PoolClient): Promise<LateBindingReport> {
  const schema = (await client.query<{ schema: string }>(
    "SELECT current_schema() AS schema",
  )).rows[0]!.schema;
  const tables: Record<string, number> = {};
  let updatedRows = 0;
  for (const table of await lateBoundTables(client, schema)) {
    const relation = `${identifier(schema)}.${identifier(table)}`;
    // `tableoid` и `ctid` адресуют физическую строку: у поздних таблиц нет общего ключа, а
    // сопоставление может дать несколько кандидатов, и тогда строка останется несвязанной и
    // видимой аудиту — это лучше, чем угаданная область.
    const result = await client.query(
      `UPDATE ${relation} target SET space_id = mapped._space_id
         FROM (SELECT _source_table, _source_row, (array_agg(_space_id))[1] AS _space_id
                 FROM (${legacyBoundaryQuery(table, schema)}) resolved
                GROUP BY _source_table, _source_row
               HAVING count(*) = 1 AND bool_and(_space_id IS NOT NULL)) mapped
        WHERE target.tableoid = mapped._source_table AND target.ctid = mapped._source_row
          AND target.space_id IS NULL`,
    );
    tables[table] = result.rowCount ?? 0;
    updatedRows += result.rowCount ?? 0;
  }
  return { tables, updatedRows };
}
