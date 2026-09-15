/** Frozen legacy row resolution for migration 104; only used by the migration runner. */
import { legacyAuditCatalog } from "./space-records-104-catalog.ts";

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

export { identifier as quoteIdentifier104 };
