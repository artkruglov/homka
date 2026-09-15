/** Migration preflight must account for retained rows without relabelling private data. */
import { readFile } from "node:fs/promises";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, database } from "../database.js";
import { auditLegacySpaces, legacyBoundaryQuery } from "./legacy-space-audit.js";
import { prepareSpacesCutover } from "./spaces-cutover.js";

const dbDescribe = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;
let family: string;
let owner: string;
let group: string;

async function snapshot(): Promise<void> {
  const sql = await readFile("migrations/103_spaces.sql", "utf8");
  await database().query(sql.slice(sql.indexOf("-- LEGACY_AUDIENCE_SNAPSHOT:")));
}

async function audit() {
  const client = await database().connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const report = await auditLegacySpaces(client);
    return report;
  } finally {
    try { await client.query("ROLLBACK"); } finally { client.release(); }
  }
}

dbDescribe("legacy space migration audit", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE families,users,telegram_ingress_updates,image_generation_operations,workspace_deletion_jobs CASCADE");
    family = (await database().query("INSERT INTO families(name) VALUES('Audit family') RETURNING id")).rows[0].id;
    owner = (await database().query("INSERT INTO users(telegram_user_id,display_name) VALUES('701','Audit owner') RETURNING id")).rows[0].id;
    await database().query("INSERT INTO family_memberships(family_id,user_id,role) VALUES($1,$2,'owner')", [family,owner]);
    group = (await database().query("INSERT INTO telegram_groups(family_id,telegram_chat_id,title,type,message_mode) VALUES($1,'-701','Audit group','external','addressed_only') RETURNING id", [family])).rows[0].id;
  });
  afterAll(closeDatabase);

  it("requires a stable read-only transaction instead of producing a changing partial snapshot", async () => {
    const client = await database().connect();
    try {
      await expect(auditLegacySpaces(client)).rejects.toMatchObject({ code: "AGENT_SPACE_AUDIT_TRANSACTION_REQUIRED" });
    } finally { client.release(); }
  });

  it("classifies the whole installed schema and maps personal plans independently of a shared task", async () => {
    await snapshot();
    const task = (await database().query(`INSERT INTO shared_tasks(family_id,group_id,scope,creator_telegram_id,assignee_telegram_id,title,status)
      VALUES($1,$2,'group','701','701','Do not expose this title','accepted') RETURNING id`, [family,group])).rows[0].id;
    await database().query("INSERT INTO shared_task_plans(task_id,telegram_user_id,planned_from,planned_until) VALUES($1,'701','2026-09-10','2026-09-11')", [task]);
    const report = await audit();
    expect(report.unclassifiedRelations).toEqual([]);
    expect(report.missingRelations).toEqual([]);
    expect(report.blockers.filter((code) => !code.startsWith("AGENT_SPACE_AUDIT_UNBOUND_ROWS:"))).toEqual([]);
    expect(report.tables.find((t) => t.table === "shared_task_plans")).toMatchObject({ totalRows: 1, mappedRows: 1, unmappedRows: 0 });
    const plans = await database().query(`SELECT r._space_id,s.kind FROM (${legacyBoundaryQuery("shared_task_plans")}) r JOIN spaces s ON s.id=r._space_id`);
    const tasks = await database().query(`SELECT r._space_id,s.kind FROM (${legacyBoundaryQuery("shared_tasks")}) r JOIN spaces s ON s.id=r._space_id`);
    expect(plans.rows[0].kind).toBe("personal");
    expect(tasks.rows[0].kind).toBe("group");
    expect(plans.rows[0]._space_id).not.toBe(tasks.rows[0]._space_id);
    expect(JSON.stringify(report)).not.toContain("Do not expose this title");
  });

  it("distinguishes a possible mapping from an actually stored correct binding", async () => {
    await snapshot();
    const id = (await database().query("INSERT INTO workspaces(family_id,owner_user_id,scope) VALUES($1,$2,'personal') RETURNING id", [family,owner])).rows[0].id;
    const before = await audit();
    expect(before.tables.find((t) => t.table === "workspaces")).toMatchObject({ mappedRows: 1, unboundRows: 1, bindingMismatchRows: 0 });
    expect(before.blockers).toContain("AGENT_SPACE_AUDIT_UNBOUND_ROWS:workspaces");
    const wrong = (await database().query("SELECT id FROM spaces WHERE family_id=$1 AND kind='legacy_family'", [family])).rows[0].id;
    await database().query("UPDATE workspaces SET space_id=$1 WHERE id=$2", [wrong,id]);
    const after = await audit();
    expect(after.tables.find((t) => t.table === "workspaces")).toMatchObject({ unboundRows: 0, bindingMismatchRows: 1 });
    expect(after.blockers).toContain("AGENT_SPACE_AUDIT_BINDING_MISMATCH:workspaces");
  });

  it("includes soft-deleted memory instead of relying on the visible memory_items view", async () => {
    await snapshot();
    await database().query(`INSERT INTO memory_items_all(family_id,owner_user_id,scope,content,source,kind,confirmation,sensitivity,operation_key,deleted_at)
      VALUES($1,$2,'personal','Private retained text','test','preference','user_confirmed','normal','audit-deleted',now())`, [family,owner]);
    const report = await audit();
    expect(report.tables.find((t) => t.table === "memory_items_all")).toMatchObject({ totalRows: 1, mappedRows: 1 });
    expect(JSON.stringify(report)).not.toContain("Private retained text");
  });

  it("blocks a former member's retained personal data rather than falling back to family", async () => {
    await database().query("INSERT INTO workspaces(family_id,owner_user_id,scope) VALUES($1,$2,'personal')", [family,owner]);
    await database().query("DELETE FROM family_memberships WHERE family_id=$1 AND user_id=$2", [family,owner]);
    await snapshot();
    const report = await audit();
    expect(report.tables.find((t) => t.table === "workspaces")).toMatchObject({ totalRows: 1, mappedRows: 0, unmappedRows: 1 });
    expect(report.blockers).toContain("AGENT_SPACE_AUDIT_UNMAPPED_ROWS:workspaces");
  });

  it("blocks newly introduced tables and views even when they have no rows", async () => {
    await snapshot();
    await database().query("CREATE TABLE future_space_content(id uuid); CREATE VIEW future_space_view AS SELECT id FROM future_space_content");
    try {
      const report = await audit();
      expect(report.unclassifiedRelations).toEqual(["future_space_content", "future_space_view"]);
      expect(report.blockers).toContain("AGENT_SPACE_AUDIT_UNCLASSIFIED_RELATIONS");
    } finally { await database().query("DROP VIEW future_space_view; DROP TABLE future_space_content"); }
  });

  it("blocks a durable operation whose workspace no longer has a recoverable boundary", async () => {
    await snapshot();
    await database().query("INSERT INTO workspace_deletion_jobs(workspace_id) VALUES('00000000-0000-4000-8000-000000000001')");
    const report = await audit();
    expect(report.blockers).toContain("AGENT_SPACE_AUDIT_UNMAPPED_ROWS:workspace_deletion_jobs");
  });

  it("does not inherit a parent's boundary when a derived row declares a different family", async () => {
    const other = (await database().query("INSERT INTO families(name) VALUES('Other audit family') RETURNING id")).rows[0].id;
    await snapshot();
    const task = (await database().query(`INSERT INTO shared_tasks(family_id,scope,creator_telegram_id,assignee_telegram_id,title,status)
      VALUES($1,'personal','701','701','Task','accepted') RETURNING id`, [family])).rows[0].id;
    await database().query("INSERT INTO shared_task_operations(family_id,operation_key,actor_telegram_id,request_hash,task_id) VALUES($1,'audit-op','701','hash',$2)", [other,task]);
    const report = await audit();
    expect(report.tables.find((t) => t.table === "shared_task_operations")).toMatchObject({ unmappedRows: 1 });
    expect(report.blockers).toContain("AGENT_SPACE_AUDIT_UNMAPPED_ROWS:shared_task_operations");
  });

  it("requires rebuilding derived profile snapshots and never treats them as ordinary family memory", async () => {
    await snapshot();
    const conversation = (await database().query("SELECT id FROM application_conversations WHERE owner_user_id=$1", [owner])).rows[0].id;
    await database().query("INSERT INTO profile_views(family_id,viewer_conversation_id,viewer_user_id,subject_count,claim_count,total_characters) VALUES($1,$2,$3,0,0,0)", [family,conversation,owner]);
    const report = await audit();
    expect(report.tables.find((t) => t.table === "profile_views")).toMatchObject({ action: "rebuild", totalRows: 1, pendingRows: 1 });
    expect(report.blockers).toContain("AGENT_SPACE_AUDIT_PENDING_REBUILD:profile_views");
    await database().query("INSERT INTO audit_events(family_id,event_type) VALUES($1,'test.legacy')", [family]);
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      await prepareSpacesCutover(client, { familyId: family, changedBy: owner, now: new Date(), reason: "Rehearsal" });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
    const prepared = await audit();
    expect(prepared.tables.find((t) => t.table === "profile_views")).toMatchObject({ totalRows: 0, pendingRows: 0 });
    expect(prepared.tables.find((t) => t.table === "audit_events")).toMatchObject({ totalRows: 1, pendingRows: 0 });
    expect((await database().query("SELECT id FROM application_conversations WHERE id=$1", [conversation])).rowCount).toBe(1);
  });

  it("rejects ambiguous mappings if a database copy has lost its target uniqueness constraint", async () => {
    await snapshot();
    await database().query("INSERT INTO workspaces(family_id,owner_user_id,scope) VALUES($1,$2,'personal')", [family,owner]);
    await database().query("DROP INDEX spaces_legacy_partition");
    let duplicate: string | undefined;
    try {
      duplicate = (await database().query("INSERT INTO spaces(family_id,kind,title,owner_user_id,legacy_scope) VALUES($1,'personal','Duplicate',$2,'personal') RETURNING id", [family,owner])).rows[0].id;
      const report = await audit();
      expect(report.tables.find((t) => t.table === "workspaces")).toMatchObject({ totalRows: 1, mappedRows: 0, ambiguousRows: 1 });
      expect(report.blockers).toContain("AGENT_SPACE_AUDIT_AMBIGUOUS_ROWS:workspaces");
    } finally {
      // Живое пространство удалить нельзя: сначала архивация, как и в жизни.
      if (duplicate) {
        await database().query("UPDATE spaces SET state='archived' WHERE id=$1", [duplicate]);
        await database().query("DELETE FROM spaces WHERE id=$1", [duplicate]);
      }
      await database().query("CREATE UNIQUE INDEX spaces_legacy_partition ON spaces(family_id,legacy_scope,owner_user_id,source_group_id) NULLS NOT DISTINCT WHERE legacy_scope IS NOT NULL");
    }
  });
});
