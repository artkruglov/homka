/**
 * Frozen data hook for 104. Called in the SQL migration's transaction before recording its ledger.
 * The v103 audience catalog is intentionally frozen: later catalog edits must not change a fresh
 * installation's historical migration. This hook never makes groups active or adds a reader.
 */
import type { Client } from "pg";
import { legacyAuditCatalog } from "./space-records-104-catalog.ts";
import { legacyBoundaryQuery, quoteIdentifier104 as q } from "./space-records-104-sql.ts";

type MigrationClient = Pick<Client, "query">;
interface Counts { totalRows: number; updatedRows: number }
interface Column { table_name: string; column_name: string; udt_name: string }
interface Trigger { tgname: string; tgenabled: "O" | "A" | "R" | "D" }
const ledgerTable = "space_record_migration_runs";
const mappedTables = Object.keys(legacyAuditCatalog).filter((table) => legacyAuditCatalog[table]!.action === "map").sort();

function fail(code: string, table?: string): never {
  // No row identifiers or user contents in the migration error.
  throw new Error(`${code}${table ? `: ${table}` : ""}`);
}
function rows(value: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) fail("AGENT_SPACE_MIGRATION_COUNT_INVALID");
  return number;
}

async function addBindingColumn(client: MigrationClient, schema: string, table: string, columns: Column[]) {
  const relation = `${q(schema)}.${q(table)}`;
  const existing = columns.find((c) => c.column_name === "space_id");
  if (existing && existing.udt_name !== "uuid") fail("AGENT_SPACE_MIGRATION_COLUMN_INVALID", table);
  if (!existing) await client.query(`ALTER TABLE ${relation} ADD COLUMN space_id uuid`);
  const ownFamily = columns.some((c) => c.column_name === "family_id");
  const foreignKey = `${table}_space_id_fkey`;
  // `confdelsetcols` проверяется поимённо: `ON DELETE SET NULL` без списка колонок обнуляет их
  // все, и удаление пространства утащило бы за собой `family_id` строки — та ушла бы из-под всех
  // прежних проверок по семье, а не только потеряла область.
  const constraint = (await client.query<{ valid: boolean }>(
    `SELECT convalidated AND contype='f' AND confrelid=$2::regclass
       AND confdeltype='n' AND condeferrable AND condeferred AND array_length(conkey,1)=$4
       AND confdelsetcols = ARRAY[(SELECT attnum FROM pg_attribute
             WHERE attrelid=$1::regclass AND attname='space_id' AND NOT attisdropped)] AS valid
     FROM pg_constraint WHERE conrelid=$1::regclass AND conname=$3`,
    [relation, `${q(schema)}.spaces`, foreignKey, ownFamily ? 2 : 1],
  )).rows[0];
  if (constraint && !constraint.valid) fail("AGENT_SPACE_MIGRATION_CONSTRAINT_INVALID", table);
  if (!constraint) {
    // Clearing only the new metadata column preserves existing family/group deletion and durable
    // filesystem cleanup semantics. Final content NOT NULL/cascade policies belong to the cutover.
    await client.query(`ALTER TABLE ${relation} ADD CONSTRAINT ${q(foreignKey)}
      FOREIGN KEY (space_id${ownFamily ? ",family_id" : ""})
      REFERENCES ${q(schema)}.spaces(id${ownFamily ? ",family_id" : ""}) ON DELETE SET NULL (space_id)
      DEFERRABLE INITIALLY DEFERRED`);
  }
  // Leading space_id serves both scoped reads and the parent cleanup lookup. Keep the FK in the
  // same order; a family-leading FK otherwise lacks a leading index in several provenance tables.
  await client.query(`CREATE INDEX IF NOT EXISTS ${q(`${table}_space_id_idx`)} ON ${relation}(space_id${ownFamily ? ",family_id" : ""})`);
  const guard = (await client.query(
    "SELECT 1 FROM pg_trigger WHERE tgrelid=$1::regclass AND tgname='space_record_boundary_guard'", [relation],
  )).rowCount;
  if (!guard) await client.query(`CREATE TRIGGER space_record_boundary_guard BEFORE UPDATE OF space_id ON ${relation}
    FOR EACH ROW EXECUTE FUNCTION ${q(schema)}.guard_space_record_boundary()`);
}

async function bindParentReferences(client: MigrationClient, schema: string) {
  for (const table of mappedTables) {
    const rule = legacyAuditCatalog[table]!;
    // A personal plan intentionally refers to a task from another audience. Its task access is
    // rechecked separately; requiring the parent's audience here would make the plan public.
    if (rule.separateAudience) continue;
    for (const [index,parent] of (rule.parents ?? []).entries()) {
      const childRelation = `${q(schema)}.${q(table)}`;
      const parentRelation = `${q(schema)}.${q(parent.table)}`;
      const target = parent.target ?? "id";
      const existingLink = (await client.query(
        `SELECT 1 FROM pg_constraint c
         JOIN pg_attribute child ON child.attrelid=c.conrelid AND child.attname=$3
         JOIN pg_attribute parent ON parent.attrelid=c.confrelid AND parent.attname=$4
         WHERE c.contype='f' AND c.conrelid=$1::regclass AND c.confrelid=$2::regclass
           AND c.confkey[array_position(c.conkey,child.attnum)]=parent.attnum LIMIT 1`,
        [childRelation,parentRelation,parent.field,target],
      )).rowCount;
      // Cleanup jobs deliberately retain a workspace ID after its deletion. Do not turn that
      // logical source into a new hard FK that prevents deleting a family or cleaning its files.
      if (!existingLink) continue;
      await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS ${q(`${parent.table}_${target}_space_uidx`)}
        ON ${parentRelation}(${q(target)},space_id)`);
      const name = `${table}_space_parent_${index}`;
      const present = (await client.query("SELECT 1 FROM pg_constraint WHERE conrelid=$1::regclass AND conname=$2", [childRelation,name])).rowCount;
      if (!present) await client.query(`ALTER TABLE ${childRelation} ADD CONSTRAINT ${q(name)}
        FOREIGN KEY (${q(parent.field)},space_id) REFERENCES ${parentRelation}(${q(target)},space_id)
        DEFERRABLE INITIALLY DEFERRED`);
    }
  }
}

async function writeBindings(client: MigrationClient, schema: string, table: string): Promise<number> {
  const relation = `${q(schema)}.${q(table)}`;
  const result = await client.query(
    `UPDATE ${relation} target SET space_id=mapped._space_id
     FROM (${legacyBoundaryQuery(table, schema)}) mapped
     WHERE target.tableoid=mapped._source_table AND target.ctid=mapped._source_row AND target.space_id IS NULL AND mapped._space_id IS NOT NULL`,
  );
  return result.rowCount ?? 0;
}

export async function backfillSpaceRecords104(client: MigrationClient): Promise<Counts & { tables: Record<string, Counts> }> {
  // SAVEPOINT fails outside a transaction. A failure rolls back every partial DDL/write and restores
  // trigger modes; the runner also rolls back the enclosing SQL migration and its ledger entry.
  await client.query("SAVEPOINT space_records_104");
  try {
    const schema = (await client.query<{ schema: string }>("SELECT current_schema() AS schema")).rows[0]!.schema;
    const relations = (await client.query<{ name: string; kind: string }>(
      `SELECT c.relname AS name,c.relkind AS kind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname=$1 AND c.relkind IN ('r','p','v','m','f') ORDER BY c.relname`, [schema],
    )).rows;
    const expected = new Set([...Object.keys(legacyAuditCatalog), ledgerTable]);
    // Каждое отношение замороженного каталога обязано существовать: без него перенос неполон.
    if ([...expected].some((name) => !relations.some((r) => r.name === name))) {
      fail("AGENT_SPACE_MIGRATION_SCHEMA_INCOMPLETE");
    }
    // Лишнее отношение означает несопоставленные данные и тоже останавливает перенос. Исключение
    // одно: когда 104 выполняется поверх уже применённых более поздних миграций (так её вызывают
    // тесты), лишние отношения создали именно они, и замороженный каталог знать о них не может.
    // При обычном применении по порядку такого состояния не бывает: ledger доходит только до 103.
    const laterMigrations = (await client.query<{ later: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE name > $1) AS later`,
      ["104_space_record_bindings.sql"],
    )).rows[0]!.later;
    const unexpected = relations.filter((r) => !expected.has(r.name));
    if (unexpected.length > 0 && !laterMigrations) fail("AGENT_SPACE_MIGRATION_SCHEMA_INCOMPLETE");
    const owned = relations.filter((r) => expected.has(r.name));
    await client.query(`LOCK TABLE ${owned.filter((r) => r.kind !== "v").map((r) => `${q(schema)}.${q(r.name)}`).join(",")}
      IN SHARE ROW EXCLUSIVE MODE`);
    const allColumns = (await client.query<Column>(
      "SELECT table_name,column_name,udt_name FROM information_schema.columns WHERE table_schema=$1", [schema],
    )).rows;
    const result: Counts & { tables: Record<string, Counts> } = { totalRows: 0, updatedRows: 0, tables: {} };
    // Prove every mapping before the first authored data update. A repeat may fill newly written
    // unbound legacy rows, but can never overwrite a row that already names a different space.
    for (const table of mappedTables) {
      const columns = allColumns.filter((c) => c.table_name === table);
      const hasBinding = columns.some((c) => c.column_name === "space_id");
      const hasFamily = columns.some((c) => c.column_name === "family_id");
      const summary = (await client.query<{ total: string; invalid: boolean; ambiguous: boolean; conflict: boolean }>(
        `SELECT count(*)::text AS total,
          coalesce(bool_or(NOT valid),false) AS invalid,
          coalesce(bool_or(resolutions <> 1),false) AS ambiguous,
          coalesce(bool_or(conflict),false) AS conflict
         FROM (SELECT _source_table,_source_row,count(*) AS resolutions,
           bool_and(_retained_control OR coalesce(_space_id IS NOT NULL ${hasFamily ? "AND family_id=_family_id" : ""},false)) AS valid,
           bool_or(NOT _retained_control AND (${hasBinding ? "space_id IS NOT NULL AND space_id IS DISTINCT FROM _space_id" : "false"})) AS conflict
           FROM (${legacyBoundaryQuery(table, schema)}) source GROUP BY _source_table,_source_row) grouped`,
      )).rows[0]!;
      if (summary.ambiguous) fail("AGENT_SPACE_MIGRATION_AMBIGUOUS", table);
      if (summary.invalid) fail("AGENT_SPACE_MIGRATION_UNMAPPED", table);
      if (summary.conflict) fail("AGENT_SPACE_MIGRATION_BINDING_CONFLICT", table);
      result.tables[table] = { totalRows: rows(summary.total), updatedRows: 0 };
      result.totalRows += rows(summary.total);
    }
    for (const table of mappedTables) {
      await addBindingColumn(client, schema, table, allColumns.filter((c) => c.table_name === table));
    }
    await bindParentReferences(client, schema);
    const preservedTriggers = new Map<string, Trigger[]>();
    // Complete DDL before updates can queue deferred FK checks. All source tables are locked;
    // concurrent writes cannot observe any handler disabled during this transaction.
    for (const table of mappedTables) {
      const relation = `${q(schema)}.${q(table)}`;
      const triggers = (await client.query<Trigger>(
        "SELECT tgname,tgenabled FROM pg_trigger WHERE tgrelid=$1::regclass AND NOT tgisinternal ORDER BY tgname", [relation],
      )).rows;
      preservedTriggers.set(table,triggers);
      for (const trigger of triggers) if (trigger.tgenabled !== "D") {
        await client.query(`ALTER TABLE ${relation} DISABLE TRIGGER ${q(trigger.tgname)}`);
      }
    }
    for (const table of mappedTables) {
      const updatedRows = await writeBindings(client, schema, table);
      result.tables[table]!.updatedRows = updatedRows;
      result.updatedRows += updatedRows;
    }
    // The runner owns this migration transaction and commits immediately after the hook. Flush the
    // deferred parent checks before restoring triggers (ALTER TABLE rejects pending trigger events).
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    for (const [table,triggers] of preservedTriggers) for (const trigger of triggers) if (trigger.tgenabled !== "D") {
      const mode = trigger.tgenabled === "A" ? "ALWAYS " : trigger.tgenabled === "R" ? "REPLICA " : "";
      await client.query(`ALTER TABLE ${q(schema)}.${q(table)} ENABLE ${mode}TRIGGER ${q(trigger.tgname)}`);
    }
    // PostgreSQL expands SELECT * at view creation time; explicitly expose the appended column while
    // retaining the authored soft-delete filter from migrations 078/084.
    await client.query(`CREATE OR REPLACE VIEW ${q(schema)}.memory_items AS SELECT * FROM ${q(schema)}.memory_items_all WHERE deleted_at IS NULL`);
    await client.query(`INSERT INTO ${q(schema)}.${q(ledgerTable)}(migration,table_counts,total_rows,updated_rows) VALUES(104,$1,$2,$3)`,
      [JSON.stringify(result.tables),result.totalRows,result.updatedRows]);
    await client.query("RELEASE SAVEPOINT space_records_104");
    return result;
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT space_records_104");
    await client.query("RELEASE SAVEPOINT space_records_104");
    throw error;
  }
}
