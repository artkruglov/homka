/**
 * Строки таблиц, появившихся после переноса 104, тоже должны получить область до переключения.
 *
 * Перенос 104 заморожен: он связал ровно то, что существовало на момент миграции, и о более
 * поздних таблицах знать не может. Пока семья живёт в прежнем режиме, покупки и переданные
 * сообщения пишутся без области, а ворота перехода требуют, чтобы несвязанных строк не осталось.
 * Без этой привязки семья, воспользовавшаяся списком покупок, не смогла бы перейти никогда.
 */
import { readFile } from "node:fs/promises";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { backfillSpaceRecords104 } from "../../../scripts/migration-data/space-records-104.ts";
import { bindLateSpaceRecords } from "./bind-late-space-records.js";
import { videoOperationRepository } from "../video-generation/video-operation-repository.js";
import { auditLegacySpaces } from "./legacy-space-audit.js";

const dbDescribe = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;

let family = "";
let group = "";
let owner = "";

async function snapshot(): Promise<void> {
  const sql = await readFile("migrations/103_spaces.sql", "utf8");
  await database().query(sql.slice(sql.indexOf("-- LEGACY_AUDIENCE_SNAPSHOT:")));
}

async function unboundBlockers(): Promise<string[]> {
  const client = await database().connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const report = await auditLegacySpaces(client);
    return report.blockers.filter((code) => code.startsWith("AGENT_SPACE_AUDIT_UNBOUND_ROWS"));
  } finally {
    try { await client.query("ROLLBACK"); } finally { client.release(); }
  }
}

async function bind(): Promise<number> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    // Порядок тот же, что в `npm run bind:legacy-spaces`: сначала замороженный перенос, потом
    // поздние таблицы. Иначе строки снимка 103 остались бы несвязанными и по чужой причине.
    await backfillSpaceRecords104(client);
    const report = await bindLateSpaceRecords(client);
    await client.query("COMMIT");
    return report.updatedRows;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

dbDescribe("binding records of tables added after the frozen migration", () => {
  beforeEach(async () => {
    await database().query(
      "TRUNCATE families,users,telegram_ingress_updates,image_generation_operations,workspace_deletion_jobs,video_generation_operations,video_budget_reservations,video_budget_accounts CASCADE",
    );
    family = (await database().query<{ id: string }>(
      "INSERT INTO families(name) VALUES('Late binding family') RETURNING id",
    )).rows[0]!.id;
    owner = (await database().query<{ id: string }>(
      "INSERT INTO users(telegram_user_id,display_name) VALUES('801','Владелец') RETURNING id",
    )).rows[0]!.id;
    await database().query(
      "INSERT INTO family_memberships(family_id,user_id,role) VALUES($1,$2,'owner')", [family, owner],
    );
    group = (await database().query<{ id: string }>(
      `INSERT INTO telegram_groups(family_id,telegram_chat_id,title,type,message_mode)
       VALUES($1,'-801','Семья','family_private','addressed_only') RETURNING id`, [family],
    )).rows[0]!.id;
    await snapshot();
  });
  afterAll(closeDatabase);

  it("binds a shopping item and a relayed message written in the previous mode", async () => {
    await database().query(
      `INSERT INTO shopping_items(family_id,list_name,title,added_by_telegram_id)
       VALUES($1,'Продукты','Молоко','801')`, [family],
    );
    await database().query(
      `INSERT INTO chat_message_relays(family_id,group_id,author_user_id,operation_key,text)
       VALUES($1,$2,$3,'relay-1','Буду через час')`, [family, group, owner],
    );
    expect(await unboundBlockers()).toEqual(expect.arrayContaining([
      "AGENT_SPACE_AUDIT_UNBOUND_ROWS:shopping_items",
      "AGENT_SPACE_AUDIT_UNBOUND_ROWS:chat_message_relays",
    ]));

    expect(await bind()).toBe(2);
    expect(await unboundBlockers()).toEqual([]);
    const bound = await database().query<{ kind: string }>(
      `SELECT space.kind::text AS kind FROM shopping_items item
         JOIN spaces space ON space.id = item.space_id WHERE item.family_id = $1`, [family],
    );
    expect(bound.rows).toEqual([{ kind: "legacy_family" }]);
  });

  it("binds legacy video receipts without changing billing or job identity", async () => {
    const workspace = (await database().query<{id:string}>(
      "INSERT INTO workspaces(family_id,scope,owner_user_id) VALUES($1,'personal',$2) RETURNING id",
      [family, owner],
    )).rows[0]!.id;
    await database().query("INSERT INTO video_budget_accounts VALUES('801','2026-09')");
    await database().query(`INSERT INTO video_budget_reservations
      (operation_key,actor_telegram_id,month,input_hash,reserved_micros)
      VALUES('late-video','801','2026-09',repeat('a',64),1000000)`);
    await database().query(`INSERT INTO video_generation_operations
      (operation_key,workspace_id,target_key,model,output_path)
      VALUES('late-video',$1,'private:801','bytedance/seedance-2.5','video.mp4')`, [workspace]);
    expect(await unboundBlockers()).toContain('AGENT_SPACE_AUDIT_UNBOUND_ROWS:video_generation_operations');
    expect(await bind()).toBe(1);
    expect(await unboundBlockers()).toEqual([]);
    const receipt = (await database().query(`SELECT o.space_id=w.space_id AS bound,
      b.input_hash,b.reserved_micros FROM video_generation_operations o
      JOIN workspaces w ON w.id=o.workspace_id JOIN video_budget_reservations b USING(operation_key)`)).rows[0];
    expect(receipt).toEqual({bound:true,input_hash:'a'.repeat(64),reserved_micros:'1000000'});
    expect(await bind()).toBe(0);
    await expect(database().query("UPDATE video_generation_operations SET space_id=NULL"))
      .rejects.toThrow(/AGENT_SPACE_RECORD_BOUNDARY_IMMUTABLE/);
    await videoOperationRepository.begin({operationKey:'new-video',workspaceId:workspace,
      targetKey:'private:801',actorTelegramId:'801',inputHash:'b'.repeat(64),reservedMicros:1000000,
      outputPath:'new-video.mp4',model:'bytedance/seedance-2.5'});
    expect((await database().query(`SELECT o.space_id=w.space_id AS bound
      FROM video_generation_operations o JOIN workspaces w ON w.id=o.workspace_id
      WHERE operation_key='new-video'`)).rows[0].bound).toBe(true);
    await database().query('DELETE FROM workspaces WHERE id=$1', [workspace]);
    expect((await database().query('SELECT count(*)::int AS n FROM video_generation_operations')).rows[0].n).toBe(2);
  });

  it("repeats without touching a row that already names its area", async () => {
    const space = (await database().query<{ id: string }>(
      "SELECT id FROM spaces WHERE family_id=$1 AND kind='legacy_family'", [family],
    )).rows[0]!.id;
    await database().query(
      `INSERT INTO shopping_items(family_id,space_id,list_name,title,added_by_telegram_id)
       VALUES($1,$2,'Продукты','Хлеб','801')`, [family, space],
    );
    expect(await bind()).toBe(0);
    expect(await bind()).toBe(0);
    expect(await unboundBlockers()).toEqual([]);
  });
});
