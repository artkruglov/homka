/** The metadata backfill is atomic and cannot change old contents, audiences or timestamps. */
import { readFile } from "node:fs/promises";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, database } from "../database.js";
import { auditLegacySpaces } from "./legacy-space-audit.js";
import { backfillSpaceRecords104 } from "../../../scripts/migration-data/space-records-104.ts";

const dbDescribe = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;
let family: string;
let owner: string;
let group: string;

async function snapshot() {
  const sql = await readFile("migrations/103_spaces.sql", "utf8");
  await database().query(sql.slice(sql.indexOf("-- LEGACY_AUDIENCE_SNAPSHOT:")));
}
async function backfill() {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const result = await backfillSpaceRecords104(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

dbDescribe("space record migration 104", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE families,users,telegram_ingress_updates,image_generation_operations,workspace_deletion_jobs,workspace_operations CASCADE");
    family = (await database().query("INSERT INTO families(name) VALUES('Migration family') RETURNING id")).rows[0].id;
    owner = (await database().query("INSERT INTO users(telegram_user_id,display_name) VALUES('801','Migration owner') RETURNING id")).rows[0].id;
    await database().query("INSERT INTO family_memberships(family_id,user_id,role) VALUES($1,$2,'owner')", [family,owner]);
    group = (await database().query("INSERT INTO telegram_groups(family_id,telegram_chat_id,title,type,message_mode) VALUES($1,'-801','Migration group','external','addressed_only') RETURNING id", [family])).rows[0].id;
  });
  afterAll(closeDatabase);

  it("retains delivered orphan receipts and chunks without assigning an audience or losing deduplication", async () => {
    await snapshot();
    const id=(await database().query(`INSERT INTO telegram_final_deliveries
      (eve_session_id,eve_turn_id,output_hash,expected_chunk_count,status,started_at,completed_at)
      VALUES('orphan-migration-104','turn_0',repeat('a',64),1,'delivered',now(),now()) RETURNING id`)).rows[0].id;
    try {
      await database().query(`INSERT INTO telegram_progress_notices(eve_session_id,eve_turn_id,step_index,telegram_message_id,sent_at)
        VALUES('orphan-migration-104','turn_0',0,998,now())`);
      await database().query(`INSERT INTO telegram_final_delivery_chunks
        (delivery_id,ordinal,content_hash,telegram_message_id,telegram_chat_type)
        VALUES($1,0,repeat('b',64),999,'private')`,[id]);
      const before=(await database().query("SELECT to_jsonb(d) AS row FROM telegram_final_deliveries d WHERE id=$1",[id])).rows[0].row;
      await backfill();
      expect((await database().query("SELECT to_jsonb(d) AS row FROM telegram_final_deliveries d WHERE id=$1",[id])).rows[0].row).toEqual(before);
      expect((await database().query("SELECT space_id FROM telegram_final_delivery_chunks WHERE delivery_id=$1",[id])).rows[0].space_id).toBeNull();
      const client=await database().connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const report=await auditLegacySpaces(client);
        expect(report.tables.find(t=>t.table==='telegram_progress_notices')).toMatchObject({retainedControlRows:1,unmappedRows:0,unboundRows:0});
        expect(report.tables.find(t=>t.table==='telegram_final_deliveries')).toMatchObject({retainedControlRows:1,unmappedRows:0,unboundRows:0});
        expect(report.tables.find(t=>t.table==='telegram_final_delivery_chunks')).toMatchObject({retainedControlRows:1,unmappedRows:0,unboundRows:0});
      } finally {await client.query("ROLLBACK");client.release();}
    } finally {await database().query("DELETE FROM telegram_final_deliveries WHERE id=$1",[id]);
      await database().query("DELETE FROM telegram_progress_notices WHERE eve_session_id='orphan-migration-104'");}
  });

  it("does not excuse an unfinished orphan delivery as a terminal receipt",async()=>{
    await snapshot();
    const id=(await database().query(`INSERT INTO telegram_final_deliveries
      (eve_session_id,eve_turn_id,output_hash,expected_chunk_count)
      VALUES('orphan-pending-104','turn_0',repeat('a',64),1) RETURNING id`)).rows[0].id;
    try {await expect(backfill()).rejects.toThrow('AGENT_SPACE_MIGRATION_UNMAPPED');}
    finally {await database().query("DELETE FROM telegram_final_deliveries WHERE id=$1",[id]);}
  });

  it("binds existing data and personal plans to their own audiences and is idempotent", async () => {
    await snapshot();
    const task = (await database().query(`INSERT INTO shared_tasks(family_id,group_id,scope,creator_telegram_id,assignee_telegram_id,title,status)
      VALUES($1,$2,'group','801','801','An existing task','accepted') RETURNING id`, [family,group])).rows[0].id;
    await database().query("INSERT INTO shared_task_plans(task_id,telegram_user_id,planned_from,planned_until) VALUES($1,'801','2026-09-10','2026-09-11')", [task]);
    const result = await backfill();
    expect(result.updatedRows).toBeGreaterThan(0);
    const rows = (await database().query(`SELECT t.space_id AS task_space,p.space_id AS plan_space,s.kind
      FROM shared_tasks t JOIN shared_task_plans p ON p.task_id=t.id JOIN spaces s ON s.id=p.space_id WHERE t.id=$1`, [task])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("personal");
    expect(rows[0].task_space).not.toBe(rows[0].plan_space);
    expect((await backfill()).updatedRows).toBe(0);
  });

  it("refuses a foreign key that would clear more than the area of a record", async () => {
    await snapshot();
    await backfill();
    // `ON DELETE SET NULL` без списка колонок обнуляет их все: удаление пространства утащило бы
    // за собой семью строки, и та ушла бы из-под всех прежних проверок.
    await database().query("ALTER TABLE reminders DROP CONSTRAINT reminders_space_id_fkey");
    try {
      await database().query(`ALTER TABLE reminders ADD CONSTRAINT reminders_space_id_fkey
        FOREIGN KEY (space_id,family_id) REFERENCES spaces(id,family_id) ON DELETE SET NULL
        DEFERRABLE INITIALLY DEFERRED`);
      await expect(backfill()).rejects.toThrowError(/AGENT_SPACE_MIGRATION_CONSTRAINT_INVALID/);
    } finally {
      // Ключ общий для всей тестовой базы: испорченным его оставлять нельзя.
      await database().query("ALTER TABLE reminders DROP CONSTRAINT IF EXISTS reminders_space_id_fkey");
      await database().query(`ALTER TABLE reminders ADD CONSTRAINT reminders_space_id_fkey
        FOREIGN KEY (space_id,family_id) REFERENCES spaces(id,family_id) ON DELETE SET NULL (space_id)
        DEFERRABLE INITIALLY DEFERRED`);
    }
  });

  it("binds a record written after the migration when the binding runs again", async () => {
    await snapshot();
    await backfill();
    // Каждый день прежнего режима добавляет строки без области: ход её ещё не выдаёт. Ворота
    // переключения требуют, чтобы несвязанных строк не осталось, поэтому привязку повторяют.
    const later = (await database().query(`INSERT INTO shared_tasks
      (family_id,scope,creator_telegram_id,assignee_telegram_id,title,status)
      VALUES($1,'family','801','801','Дело следующего дня','accepted') RETURNING id`, [family])).rows[0].id;
    const before = await database().query<{ space_id: string | null }>(
      "SELECT space_id FROM shared_tasks WHERE id=$1", [later],
    );
    expect(before.rows[0]!.space_id).toBeNull();

    const result = await backfill();

    expect(result.updatedRows).toBeGreaterThan(0);
    const after = await database().query<{ space_id: string | null }>(
      "SELECT space_id FROM shared_tasks WHERE id=$1", [later],
    );
    expect(after.rows[0]!.space_id).not.toBeNull();
  });

  it("preserves content, provenance, timestamps and enabled trigger state", async () => {
    await snapshot();
    const id = (await database().query(`INSERT INTO memory_items_all(family_id,owner_user_id,scope,content,source,kind,confirmation,sensitivity,operation_key,updated_at,deleted_at)
      VALUES($1,$2,'personal','Retained private content','test','preference','user_confirmed','normal','migration-memory','2020-01-01',now()) RETURNING id`, [family,owner])).rows[0].id;
    const before = (await database().query("SELECT to_jsonb(m)-'space_id' AS record FROM memory_items_all m WHERE id=$1", [id])).rows[0].record;
    const triggers = await database().query("SELECT tgname,tgenabled FROM pg_trigger WHERE tgrelid='memory_items_all'::regclass ORDER BY tgname");
    await backfill();
    expect((await database().query("SELECT to_jsonb(m)-'space_id' AS record FROM memory_items_all m WHERE id=$1", [id])).rows[0].record).toEqual(before);
    expect((await database().query("SELECT space_id FROM memory_items_all WHERE id=$1", [id])).rows[0].space_id).not.toBeNull();
    expect((await database().query("SELECT tgname,tgenabled FROM pg_trigger WHERE tgrelid='memory_items_all'::regclass ORDER BY tgname")).rows).toEqual(triggers.rows);
    expect((await database().query("SELECT id,space_id FROM memory_items WHERE id=$1", [id])).rowCount).toBe(0);
  });

  it("rolls back every binding when one source has no audience", async () => {
    await database().query("INSERT INTO workspaces(family_id,owner_user_id,scope) VALUES($1,$2,'personal')", [family,owner]);
    await database().query("DELETE FROM family_memberships WHERE family_id=$1 AND user_id=$2", [family,owner]);
    await snapshot();
    await expect(backfill()).rejects.toThrow(/AGENT_SPACE_MIGRATION_UNMAPPED/);
    expect((await database().query("SELECT space_id FROM telegram_groups WHERE id=$1", [group])).rows[0].space_id).toBeNull();
  });

  it("does not overwrite an already assigned different audience", async () => {
    await snapshot();
    const workspace = (await database().query("INSERT INTO workspaces(family_id,owner_user_id,scope) VALUES($1,$2,'personal') RETURNING id", [family,owner])).rows[0].id;
    const legacy = (await database().query("SELECT id FROM spaces WHERE family_id=$1 AND kind='legacy_family'", [family])).rows[0].id;
    await database().query("UPDATE workspaces SET space_id=$1 WHERE id=$2", [legacy,workspace]);
    await expect(backfill()).rejects.toThrow(/AGENT_SPACE_MIGRATION_BINDING_CONFLICT/);
    expect((await database().query("SELECT space_id FROM workspaces WHERE id=$1", [workspace])).rows[0].space_id).toBe(legacy);
  });

  it("restores earlier writes and trigger modes after an error during the update phase", async () => {
    await snapshot();
    await database().query("INSERT INTO workspaces(family_id,owner_user_id,scope) VALUES($1,$2,'personal')", [family,owner]);
    const triggers = (await database().query("SELECT tgname,tgenabled FROM pg_trigger WHERE tgrelid='telegram_groups'::regclass ORDER BY tgname")).rows;
    await database().query("ALTER TABLE workspaces ADD CONSTRAINT test_backfill_failure CHECK (space_id IS NULL)");
    try {
      await expect(backfill()).rejects.toMatchObject({ code: "23514" });
      expect((await database().query("SELECT space_id FROM telegram_groups WHERE id=$1", [group])).rows[0].space_id).toBeNull();
      expect((await database().query("SELECT tgname,tgenabled FROM pg_trigger WHERE tgrelid='telegram_groups'::regclass ORDER BY tgname")).rows).toEqual(triggers);
    } finally { await database().query("ALTER TABLE workspaces DROP CONSTRAINT test_backfill_failure"); }
  });

  it("keeps family deletion and retained workspace cleanup receipts possible", async () => {
    await snapshot();
    const workspace = (await database().query("INSERT INTO workspaces(family_id,owner_user_id,scope) VALUES($1,$2,'personal') RETURNING id", [family,owner])).rows[0].id;
    await database().query("INSERT INTO workspace_deletion_jobs(workspace_id) VALUES($1)", [workspace]);
    await backfill();
    await database().query("DELETE FROM families WHERE id=$1", [family]);
    const job = (await database().query("SELECT workspace_id,space_id FROM workspace_deletion_jobs WHERE workspace_id=$1", [workspace])).rows[0];
    expect(job).toMatchObject({ workspace_id: workspace, space_id: null });
  });

  it("rejects moving a bound record and a historical child to a different space", async () => {
    await snapshot();
    const privateTask = (await database().query(`INSERT INTO shared_tasks(family_id,scope,creator_telegram_id,assignee_telegram_id,title,status)
      VALUES($1,'personal','801','801','Private task','accepted') RETURNING id`, [family])).rows[0].id;
    const groupTask = (await database().query(`INSERT INTO shared_tasks(family_id,group_id,scope,creator_telegram_id,assignee_telegram_id,title,status)
      VALUES($1,$2,'group','801','801','Group task','accepted') RETURNING id`, [family,group])).rows[0].id;
    await database().query("INSERT INTO shared_task_versions(task_id,version,actor_telegram_id,action,previous_record) VALUES($1,1,'801','updated','{}')", [privateTask]);
    await backfill();
    const groupSpace = (await database().query("SELECT space_id FROM shared_tasks WHERE id=$1", [groupTask])).rows[0].space_id;
    await expect(database().query("UPDATE shared_tasks SET space_id=$1 WHERE id=$2", [groupSpace,privateTask]))
      .rejects.toThrow(/AGENT_SPACE_RECORD_BOUNDARY_IMMUTABLE/);
    await expect(database().query("UPDATE shared_tasks SET space_id=NULL WHERE id=$1", [privateTask]))
      .rejects.toThrow(/AGENT_SPACE_RECORD_BOUNDARY_IMMUTABLE/);
    await expect(database().query("UPDATE shared_task_versions SET task_id=$1 WHERE task_id=$2", [groupTask,privateTask]))
      .rejects.toMatchObject({ code: "23503" });
  });

  it("can unregister a reviewed group with a session/batch reference cycle", async () => {
    await snapshot();
    const conversation = (await database().query("SELECT id FROM application_conversations WHERE telegram_group_id=$1", [group])).rows[0].id;
    const lane = (await database().query("INSERT INTO memory_review_lanes(conversation_id,processed_through_sequence) VALUES($1,0) RETURNING id", [conversation])).rows[0].id;
    const session = (await database().query(`INSERT INTO conversation_sessions(thread_id,generation,family_id,group_id,scope,kind,task_state,conversation_key,continuation_token,started_at,last_activity_at)
      VALUES(gen_random_uuid(),0,$1,$2,'group','proactive','completed','migration-cycle','migration-cycle',now(),now()) RETURNING id`, [family,group])).rows[0].id;
    const batch = (await database().query(`INSERT INTO memory_review_batches(lane_id,conversation_id,batch_kind,status,predecessor_sequence,from_sequence,through_sequence,source_count,application_session_id,completed_at)
      VALUES($1,$2,'background','completed',0,1,1,1,$3,now()) RETURNING id`, [lane,conversation,session])).rows[0].id;
    await database().query("UPDATE conversation_sessions SET memory_review_batch_id=$1 WHERE id=$2", [batch,session]);
    await backfill();
    await database().query("DELETE FROM telegram_groups WHERE id=$1", [group]);
    expect((await database().query("SELECT memory_review_batch_id,space_id,retired_at FROM conversation_sessions WHERE id=$1", [session])).rows[0])
      .toMatchObject({ memory_review_batch_id: null, space_id: null, retired_at: expect.any(Date) });
  });

  it("does not silently assign new legacy writes or new family members after the snapshot", async () => {
    await snapshot();
    await backfill();
    const task = (await database().query(`INSERT INTO shared_tasks(family_id,scope,creator_telegram_id,assignee_telegram_id,title,status)
      VALUES($1,'personal','801','801','New write before cutover','accepted') RETURNING space_id`, [family])).rows[0];
    expect(task.space_id).toBeNull();
    // Final runtime cutover must reject these unbound rows; no default-family trigger is installed.
    expect((await backfill()).updatedRows).toBe(1);
  });
});
