/** Read-only preflight. Counts and stable codes only; never writes, copies content or grants access. */
import type { PoolClient } from "pg";
import { AppError } from "../app-error.js";
import { legacyAuditCatalog, type LegacyAuditRule } from "./legacy-space-audit-catalog.js";

export interface LegacyTableAudit {
  table: string;
  action: LegacyAuditRule["action"];
  reason: string;
  totalRows: number;
  mappedRows: number;
  retainedControlRows: number;
  unmappedRows: number;
  ambiguousRows: number;
  unboundRows: number;
  bindingMismatchRows: number;
  pendingRows: number;
}
export interface LegacySpaceAudit {
  tables: LegacyTableAudit[];
  unclassifiedRelations: string[];
  missingRelations: string[];
  blockers: string[];
}

function identifier(value: string): string {
  if (!/^[a-z_][a-z_0-9]*$/u.test(value)) throw new Error("Invalid authored audit identifier");
  return `"${value}"`;
}

/** Internal SQL for a fixed catalog entry, not an agent-facing query or a scope selection API. */
export function legacyBoundaryQuery(table: string, schema = "public"): string {
  const relation = (name: string) => `${identifier(schema)}.${identifier(name)}`;
  const queries = new Map<string, string>();
  const visiting = new Set<string>();
  function visit(name: string): void {
    if (queries.has(name)) return;
    const rule = legacyAuditCatalog[name];
    if (!rule || rule.action !== "map") throw new Error(`No legacy mapping rule: ${name}`);
    if (visiting.has(name)) throw new Error(`Cyclic legacy mapping rule: ${name}`);
    visiting.add(name);
    const joins: string[] = [];
    const parents = rule.parents ?? [];
    parents.forEach((parent, i) => {
      visit(parent.table);
      joins.push(`LEFT JOIN ${identifier(`_lsa_${parent.table}`)} p${i}
        ON p${i}.${identifier(parent.target ?? "id")}=x.${identifier(parent.field)}`);
    });
    for (const join of rule.joins ?? []) joins.push(`LEFT JOIN ${relation(join.table)} ${identifier(join.alias)} ON ${join.on}`);
    const boundary = rule.boundary;
    const family = boundary?.family ?? "p0._family_id";
    const space = boundary ? "s.id" : "p0._space_id";
    if (boundary) {
      joins.push(`LEFT JOIN ${relation("spaces")} s ON s.family_id=${boundary.family} AND s.legacy_scope::text=(${boundary.scope})::text
        AND ((${boundary.scope})::text <> 'personal' OR s.owner_user_id=${boundary.owner})
        AND ((${boundary.scope})::text <> 'group' OR s.source_group_id=${boundary.group})`);
    } else if (!parents.length) throw new Error(`Missing legacy boundary: ${name}`);
    const guards = [`${space} IS NOT NULL`, ...rule.guards ?? []];
    if (!rule.separateAudience) parents.forEach((parent, i) => {
      const same = `p${i}._space_id=${space} AND p${i}._family_id=${family}`;
      guards.push(parent.optional ? `(x.${identifier(parent.field)} IS NULL OR (${same}))` : `(${same})`);
    });
    queries.set(name, `${identifier(`_lsa_${name}`)} AS NOT MATERIALIZED (
      SELECT x.*, x.tableoid AS _source_table, x.ctid AS _source_row, ${family} AS _family_id,
        coalesce((${rule.retainedControlWhere ?? "false"}),false) AS _retained_control,
        CASE WHEN ${guards.map((g) => `(${g})`).join(" AND ")} THEN ${space} ELSE NULL::uuid END AS _space_id
      FROM ${relation(name)} x ${joins.join("\n")}
    )`);
    visiting.delete(name);
  }
  visit(table);
  return `WITH ${[...queries.values()].join(",\n")} SELECT * FROM ${identifier(`_lsa_${table}`)}`;
}

function count(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new AppError("AGENT_SPACE_AUDIT_COUNT_INVALID", "Не удалось точно посчитать записи для переноса");
  }
  return parsed;
}

/** Caller holds REPEATABLE READ READ ONLY for the whole report; missing mappings never fall back. */
export async function auditLegacySpaces(client: PoolClient): Promise<LegacySpaceAudit> {
  const settings = (await client.query<{ read_only: string; isolation: string; schema: string }>(
    "SELECT current_setting('transaction_read_only') AS read_only, current_setting('transaction_isolation') AS isolation, current_schema() AS schema",
  )).rows[0];
  if (settings?.read_only !== "on" || !["repeatable read", "serializable"].includes(settings.isolation)) {
    throw new AppError("AGENT_SPACE_AUDIT_TRANSACTION_REQUIRED", "Проверка переноса требует единого снимка базы в транзакции только для чтения");
  }
  const relations = (await client.query<{ name: string }>(
    `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname=current_schema() AND c.relkind IN ('r','p','v','m','f') ORDER BY c.relname`,
  )).rows.map((r) => r.name);
  const known = Object.keys(legacyAuditCatalog).sort();
  const unclassifiedRelations = relations.filter((r) => !Object.hasOwn(legacyAuditCatalog, r));
  const missingRelations = known.filter((r) => !relations.includes(r));
  const report: LegacySpaceAudit = { tables: [], unclassifiedRelations, missingRelations, blockers: [] };
  if (unclassifiedRelations.length) report.blockers.push("AGENT_SPACE_AUDIT_UNCLASSIFIED_RELATIONS");
  if (missingRelations.length) {
    report.blockers.push("AGENT_SPACE_AUDIT_MISSING_RELATIONS");
    // A missing parent may invalidate many descendant queries. Return the structural failure first.
    return report;
  }
  const bindingColumns = new Set((await client.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.columns WHERE table_schema=$1 AND column_name='space_id'", [settings.schema],
  )).rows.map((r) => r.table_name));
  for (const table of known) {
    const rule = legacyAuditCatalog[table]!;
    const mapped = rule.action === "map";
    const source = mapped ? `(${legacyBoundaryQuery(table, settings.schema)})` : `${identifier(settings.schema)}.${identifier(table)}`;
    const pending = rule.pendingWhere ?? (["rebuild", "quarantine"].includes(rule.action) ? "true" : "false");
    const hasBinding = bindingColumns.has(table);
    // Count original physical rows, not join products. Even a damaged copy with a missing unique
    // index must report multiple candidates as ambiguous rather than call both successfully mapped.
    const sql = mapped ? `SELECT count(*)::text AS total,
      count(*) FILTER (WHERE resolutions=1 AND mapped AND NOT retained_control)::text AS mapped,
      count(*) FILTER (WHERE resolutions=1 AND retained_control)::text AS retained_control,
      count(*) FILTER (WHERE resolutions>1)::text AS ambiguous,
      count(*) FILTER (WHERE unbound)::text AS unbound,
      count(*) FILTER (WHERE mismatch)::text AS mismatch,
      count(*) FILTER (WHERE pending)::text AS pending
      FROM (SELECT x._source_table,x._source_row,count(*) AS resolutions,
        bool_and(x._space_id IS NOT NULL) AS mapped, bool_and(x._retained_control) AS retained_control,bool_or(${pending}) AS pending,
        bool_or(NOT x._retained_control AND (${hasBinding ? "x.space_id IS NULL" : "true"})) AS unbound,
        bool_or(NOT x._retained_control AND (${hasBinding ? "x.space_id IS NOT NULL AND x.space_id IS DISTINCT FROM x._space_id" : "false"})) AS mismatch
        FROM ${source} x GROUP BY x._source_table,x._source_row) grouped`
      : `SELECT count(*)::text AS total,'0' AS mapped,'0' AS retained_control,'0' AS ambiguous,'0' AS unbound,'0' AS mismatch,
        count(*) FILTER (WHERE ${pending})::text AS pending FROM ${source} x`;
    const row = (await client.query<{ total: string; mapped: string; retained_control: string; ambiguous: string; unbound: string; mismatch: string; pending: string }>(sql)).rows[0]!;
    const totalRows = count(row.total);
    const mappedRows = count(row.mapped);
    const retainedControlRows = count(row.retained_control);
    const ambiguousRows = count(row.ambiguous);
    const unmappedRows = mapped ? totalRows - mappedRows - ambiguousRows - retainedControlRows : 0;
    const pendingRows = count(row.pending);
    const unboundRows = count(row.unbound);
    const bindingMismatchRows = count(row.mismatch);
    report.tables.push({ table, action: rule.action, reason: rule.reason, totalRows, mappedRows, retainedControlRows, unmappedRows, ambiguousRows, unboundRows, bindingMismatchRows, pendingRows });
    if (unmappedRows) report.blockers.push(`AGENT_SPACE_AUDIT_UNMAPPED_ROWS:${table}`);
    if (ambiguousRows) report.blockers.push(`AGENT_SPACE_AUDIT_AMBIGUOUS_ROWS:${table}`);
    if (unboundRows) report.blockers.push(`AGENT_SPACE_AUDIT_UNBOUND_ROWS:${table}`);
    if (bindingMismatchRows) report.blockers.push(`AGENT_SPACE_AUDIT_BINDING_MISMATCH:${table}`);
    if (pendingRows) report.blockers.push(`AGENT_SPACE_AUDIT_PENDING_${(rule.pendingAction ?? rule.action).toUpperCase()}:${table}`);
  }
  return report;
}
