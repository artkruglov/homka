/** Включение режима пространств разрешает база, а не дисциплина оператора. */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { sessionRepository } from "../sessions/session-repository.js";
import { readFamilySpaceMode } from "./family-space-mode.js";

const dbDescribe = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;

let family: string;
let owner: string;

async function mode(): Promise<string> {
  const client = await database().connect();
  try {
    return await readFamilySpaceMode(client, family);
  } finally {
    client.release();
  }
}

async function enable() {
  return database().query(
    "UPDATE family_space_runtime SET mode='spaces', reason='Переход' WHERE family_id=$1",
    [family],
  );
}

async function addGroup(type: "external" | "family_private", chatId: string): Promise<string> {
  return (await database().query<{ id: string }>(
    `INSERT INTO telegram_groups(family_id,telegram_chat_id,title,type,message_mode)
     VALUES($1,$2,'Группа',$3,'addressed_only') RETURNING id`,
    [family, chatId, type],
  )).rows[0]!.id;
}

async function bindGroup(groupId: string, state: string): Promise<void> {
  const spaceId = (await database().query<{ id: string }>(
    "INSERT INTO spaces(family_id,kind,title) VALUES($1,'shared','Пара') RETURNING id",
    [family],
  )).rows[0]!.id;
  await database().query(
    "INSERT INTO space_memberships(family_id,space_id,user_id,role,state) VALUES($1,$2,$3,'manager','active')",
    [family, spaceId, owner],
  );
  await database().query("UPDATE spaces SET state='active' WHERE id=$1", [spaceId]);
  // Привязка общей области всегда начинается неподтверждённой: сразу активную схема не принимает.
  await database().query(
    "INSERT INTO space_bindings(family_id,group_id,space_id,state) VALUES($1,$2,$3,'pending_verification')",
    [family, groupId, spaceId],
  );
  if (state !== "pending_verification") {
    await database().query("UPDATE space_bindings SET state=$2 WHERE group_id=$1", [groupId, state]);
  }
}

dbDescribe("family space runtime mode", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE families,users CASCADE");
    family = (await database().query<{ id: string }>(
      "INSERT INTO families(name) VALUES('Runtime family') RETURNING id",
    )).rows[0]!.id;
    owner = (await database().query<{ id: string }>(
      "INSERT INTO users(telegram_user_id,display_name) VALUES('701','Владелец') RETURNING id",
    )).rows[0]!.id;
    await database().query(
      "INSERT INTO family_memberships(family_id,user_id,role) VALUES($1,$2,'owner')",
      [family, owner],
    );
  });
  afterAll(closeDatabase);

  it("gives every new family the previous mode without anyone asking", async () => {
    await expect(mode()).resolves.toBe("legacy");
    expect((await database().query<{ cutover_at: Date | null }>(
      "SELECT cutover_at FROM family_space_runtime WHERE family_id=$1", [family],
    )).rows[0]!.cutover_at).toBeNull();
  });

  it("refuses the switch while a registered group has no space", async () => {
    await addGroup("external", "-701");
    await expect(enable()).rejects.toThrow(/AGENT_SPACE_CUTOVER_GROUP_UNBOUND/);
    await expect(mode()).resolves.toBe("legacy");
  });

  it("refuses the switch while the family group audience is unverified", async () => {
    await bindGroup(await addGroup("family_private", "-702"), "pending_verification");
    await expect(enable()).rejects.toThrow(/AGENT_SPACE_CUTOVER_AUDIENCE_UNVERIFIED/);
  });

  it("refuses the switch while any conversation still carries old history", async () => {
    await bindGroup(await addGroup("family_private", "-703"), "active");
    await sessionRepository.prepareTurn({
      baseContinuationToken: "701::",
      familyId: family,
      groupId: null,
      kind: "canonical",
      now: new Date("2026-09-11T12:00:00.000Z"),
      scope: "personal",
      telegramForumTopicId: null,
      userId: owner,
    });
    await expect(enable()).rejects.toThrow(/AGENT_SPACE_CUTOVER_SESSIONS_ACTIVE/);
  });

  it("stamps the switch once every gate is satisfied and lets it be taken back", async () => {
    await bindGroup(await addGroup("family_private", "-704"), "active");
    await enable();
    await expect(mode()).resolves.toBe("spaces");
    expect((await database().query<{ cutover_at: Date | null }>(
      "SELECT cutover_at FROM family_space_runtime WHERE family_id=$1", [family],
    )).rows[0]!.cutover_at).not.toBeNull();

    // Откат режима не должен зависеть ни от одних ворот: он и есть аварийный выход.
    await database().query(
      "UPDATE family_space_runtime SET mode='legacy', reason='Откат' WHERE family_id=$1",
      [family],
    );
    await expect(mode()).resolves.toBe("legacy");
    expect((await database().query<{ cutover_at: Date | null }>(
      "SELECT cutover_at FROM family_space_runtime WHERE family_id=$1", [family],
    )).rows[0]!.cutover_at).toBeNull();
  });
});
