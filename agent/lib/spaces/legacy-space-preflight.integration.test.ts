/** Разведка находит строки без будущей аудитории до того, как перенос откажется на проде. */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { preflightLegacySpaces } from "./legacy-space-preflight.js";

const dbDescribe = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;

let family: string;
let owner: string;
let group: string;

async function preflight() {
  const client = await database().connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    return await preflightLegacySpaces(client);
  } finally {
    try { await client.query("ROLLBACK"); } finally { client.release(); }
  }
}

dbDescribe("legacy space preflight", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE families,users CASCADE");
    family = (await database().query<{ id: string }>(
      "INSERT INTO families(name) VALUES('Preflight family') RETURNING id",
    )).rows[0]!.id;
    owner = (await database().query<{ id: string }>(
      "INSERT INTO users(telegram_user_id,display_name) VALUES('901','Preflight owner') RETURNING id",
    )).rows[0]!.id;
    await database().query(
      "INSERT INTO family_memberships(family_id,user_id,role) VALUES($1,$2,'owner')",
      [family, owner],
    );
    group = (await database().query<{ id: string }>(
      `INSERT INTO telegram_groups(family_id,telegram_chat_id,title,type,message_mode)
       VALUES($1,'-901','Preflight group','external','addressed_only') RETURNING id`,
      [family],
    )).rows[0]!.id;
  });
  afterAll(closeDatabase);

  it("reports nothing for an installation whose data all has an audience", async () => {
    await database().query(
      "INSERT INTO workspaces(family_id,owner_user_id,scope) VALUES($1,$2,'personal')",
      [family, owner],
    );
    const report = await preflight();
    expect(report.blockers).toEqual([]);
    expect(report.notes).toEqual([]);
    expect(report.unclassifiedRelations).toEqual([]);
  });

  it("names the table whose personal owner left the family", async () => {
    await database().query(
      "INSERT INTO workspaces(family_id,owner_user_id,scope) VALUES($1,$2,'personal')",
      [family, owner],
    );
    await database().query("DELETE FROM family_memberships WHERE family_id=$1 AND user_id=$2", [family, owner]);
    const report = await preflight();
    expect(report.blockers).toContain("AGENT_SPACE_PREFLIGHT_PERSONAL_WITHOUT_AUDIENCE:workspaces");
    expect(report.personalRowsWithoutCurrentMember).toContainEqual({ table: "workspaces", rows: 1 });
  });

  it("finds a planning row left by a participant this installation never enrolled", async () => {
    const task = (await database().query<{ id: string }>(
      `INSERT INTO shared_tasks(family_id,group_id,scope,creator_telegram_id,assignee_telegram_id,title,kind,status)
       VALUES($1,$2,'group','901','901','Идея внешней группы','idea','proposed') RETURNING id`,
      [family, group],
    )).rows[0]!.id;
    await database().query(
      `INSERT INTO shared_task_plans(task_id,telegram_user_id,planned_from,planned_until)
       VALUES($1,'external-participant','2026-09-11','2026-09-12')`,
      [task],
    );
    const report = await preflight();
    expect(report.taskPlansWithoutKnownUser).toBe(1);
    expect(report.blockers).toContain("AGENT_SPACE_PREFLIGHT_PLAN_WITHOUT_AUDIENCE");
  });

  it("refuses an installation carrying a relation the migration catalog does not know", async () => {
    await database().query("CREATE TABLE forgotten_backup (id uuid PRIMARY KEY)");
    try {
      const report = await preflight();
      expect(report.unclassifiedRelations).toContain("forgotten_backup");
      expect(report.blockers).toContain("AGENT_SPACE_PREFLIGHT_UNCLASSIFIED_RELATIONS");
    } finally {
      await database().query("DROP TABLE forgotten_backup");
    }
  });

  it("warns that a long Telegram title will be shortened for its space", async () => {
    await database().query(
      "UPDATE telegram_groups SET title=$2 WHERE id=$1",
      [group, "Длинное название ".repeat(10)],
    );
    const report = await preflight();
    expect(report.truncatedGroupTitles).toBe(1);
    expect(report.notes).toEqual(["AGENT_SPACE_PREFLIGHT_TITLE_TRUNCATED"]);
    expect(report.blockers).toEqual([]);
  });
});
