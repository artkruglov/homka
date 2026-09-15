/** Execute the actual migration's snapshot statements over existing family/group fixtures. */
import { readFile } from "node:fs/promises";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, database } from "../database.js";
import { resolveSpaceAccess } from "./space-access.js";

const dbDescribe = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;

dbDescribe("legacy space audience snapshot", () => {
  beforeEach(async () => { await database().query("TRUNCATE families,users CASCADE"); });
  afterAll(closeDatabase);

  it("freezes the old readers, leaves family group delivery unverified and never relabels legacy as a couple", async () => {
    const db = database();
    const family = (await db.query<{ id: string }>("INSERT INTO families(name) VALUES('Existing family') RETURNING id")).rows[0]!.id;
    const owner = (await db.query<{ id: string }>("INSERT INTO users(telegram_user_id,display_name) VALUES('501','Existing owner') RETURNING id")).rows[0]!.id;
    await db.query("INSERT INTO family_memberships(family_id,user_id,role) VALUES($1,$2,'owner')", [family,owner]);
    await db.query(`INSERT INTO telegram_groups(family_id,telegram_chat_id,title,type,message_mode) VALUES
      ($1,'-501','Existing family group','family_private','addressed_only'),
      ($1,'-502','Existing external group','external','addressed_only')`, [family]);
    const sql = await readFile("migrations/103_spaces.sql", "utf8");
    const marker = "-- LEGACY_AUDIENCE_SNAPSHOT:";
    expect(sql.includes(marker)).toBe(true);
    await db.query(sql.slice(sql.indexOf(marker)));
    const spaces = (await db.query<{ id: string; kind: string; legacy_scope: string; state: string }>(
      "SELECT id,kind,legacy_scope,state FROM spaces WHERE family_id=$1 ORDER BY kind", [family],
    )).rows;
    expect(spaces.map((s) => s.kind)).toEqual(["group", "legacy_family", "personal"]);
    expect(spaces.every((s) => s.state === "active")).toBe(true);
    expect((await db.query("SELECT role FROM space_memberships WHERE family_id=$1", [family])).rows)
      .toEqual([{ role: "manager" }, { role: "manager" }]);
    const bindings = (await db.query<{ type: string; state: string }>(
      "SELECT g.type,b.state FROM space_bindings b JOIN telegram_groups g ON g.id=b.group_id ORDER BY g.type", [],
    )).rows;
    expect(bindings).toEqual([{ type: "family_private", state: "pending_verification" }, { type: "external", state: "active" }]);

    // Becoming even the installation owner afterwards must not grant this old audience's data.
    const newcomer = (await db.query<{ id: string }>("INSERT INTO users(telegram_user_id,display_name) VALUES('502','New member') RETURNING id")).rows[0]!.id;
    await db.query("UPDATE family_memberships SET role='member' WHERE user_id=$1", [owner]);
    await db.query("INSERT INTO family_memberships(family_id,user_id,role) VALUES($1,$2,'owner')", [family,newcomer]);
    const legacy = spaces.find((s) => s.kind === "legacy_family")!;
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await expect(resolveSpaceAccess(client, { familyId: family, userId: newcomer, spaceId: legacy.id, chat: { type: "private" } }))
        .rejects.toMatchObject({ code: "AGENT_SPACE_ACCESS_DENIED" });
      await client.query("ROLLBACK");
    } finally { client.release(); }
    expect((await db.query("SELECT 1 FROM space_memberships WHERE user_id=$1", [newcomer])).rowCount).toBe(0);
  });

  it("survives a group title longer than a space title allows", async () => {
    const db = database();
    const family = (await db.query<{ id: string }>("INSERT INTO families(name) VALUES('Wide titles') RETURNING id")).rows[0]!.id;
    const owner = (await db.query<{ id: string }>("INSERT INTO users(telegram_user_id,display_name) VALUES('503','Owner') RETURNING id")).rows[0]!.id;
    await db.query("INSERT INTO family_memberships(family_id,user_id,role) VALUES($1,$2,'owner')", [family,owner]);
    // Telegram allows a 128-character chat title and `telegram_groups.title` stores it unbounded.
    const long = "Очень длинное название внешней группы ".repeat(4);
    expect(long.length).toBeGreaterThan(100);
    // Пустое название недостижимо: его отвергает проверка метки разговора при регистрации группы.
    await db.query(`INSERT INTO telegram_groups(family_id,telegram_chat_id,title,type,message_mode)
      VALUES($1,'-503',$2,'external','addressed_only')`, [family,long]);
    const sql = await readFile("migrations/103_spaces.sql", "utf8");
    await db.query(sql.slice(sql.indexOf("-- LEGACY_AUDIENCE_SNAPSHOT:")));
    const titles = (await db.query<{ title: string }>(
      "SELECT s.title FROM spaces s WHERE s.family_id=$1 AND s.source_group_id IS NOT NULL", [family],
    )).rows.map((row) => row.title);
    expect(titles).toEqual([long.slice(0, 100)]);
  });
});
