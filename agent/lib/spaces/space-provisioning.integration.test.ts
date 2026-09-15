/**
 * Снимок миграции выдал пространства только тем, кто существовал на момент переноса. Всё, что
 * появляется позже, обязано получать их при создании, иначе после включения режима человек
 * останется без личной области, а группа — без привязки, и обе будут отказаны навсегда.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { telegramGroupAdministrationRepository } from "../telegram-group-administration-repository.js";
import { provisionFamilySpaces, provisionMemberPersonalSpace } from "./space-provisioning.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const dbDescribe = enabled ? describe : describe.skip;

let familyId: string;
let ownerId: string;
let spouseId: string;

async function inTransaction(run: (client: import("pg").PoolClient) => Promise<void>): Promise<void> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    await run(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function spaces(): Promise<Array<{ kind: string; state: string; title: string }>> {
  return (await database().query<{ kind: string; state: string; title: string }>(
    "SELECT kind,state,title FROM spaces WHERE family_id=$1 ORDER BY kind,title",
    [familyId],
  )).rows;
}

dbDescribe("space provisioning", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE families,users CASCADE");
    familyId = (await database().query<{ id: string }>(
      "INSERT INTO families(name) VALUES('Provisioning') RETURNING id",
    )).rows[0]!.id;
    ownerId = (await database().query<{ id: string }>(
      "INSERT INTO users(telegram_user_id,display_name) VALUES('prov-owner','Владелец') RETURNING id",
    )).rows[0]!.id;
    spouseId = (await database().query<{ id: string }>(
      "INSERT INTO users(telegram_user_id,display_name) VALUES('prov-spouse','Супруга') RETURNING id",
    )).rows[0]!.id;
    await database().query(
      "INSERT INTO family_memberships(family_id,user_id,role) VALUES($1,$2,'owner')",
      [familyId, ownerId],
    );
  });
  afterAll(closeDatabase);

  it("gives a new installation its family area and the owner's own space", async () => {
    await inTransaction((client) => provisionFamilySpaces(client, { familyId, ownerUserId: ownerId }));
    expect(await spaces()).toEqual([
      { kind: "legacy_family", state: "active", title: "Семья" },
      { kind: "personal", state: "active", title: "Личное" },
    ]);
    expect((await database().query(
      "SELECT 1 FROM space_memberships WHERE family_id=$1 AND user_id=$2 AND state='active'",
      [familyId, ownerId],
    )).rowCount).toBe(2);
  });

  it("repeats without creating a second area", async () => {
    await inTransaction((client) => provisionFamilySpaces(client, { familyId, ownerUserId: ownerId }));
    await inTransaction((client) => provisionFamilySpaces(client, { familyId, ownerUserId: ownerId }));
    expect(await spaces()).toHaveLength(2);
  });

  it("gives a later member only their own space, never the frozen family area", async () => {
    await inTransaction((client) => provisionFamilySpaces(client, { familyId, ownerUserId: ownerId }));
    await database().query(
      "INSERT INTO family_memberships(family_id,user_id,role) VALUES($1,$2,'member')",
      [familyId, spouseId],
    );
    await inTransaction((client) => provisionMemberPersonalSpace(client, { familyId, userId: spouseId }));
    const own = await database().query<{ kind: string }>(
      `SELECT s.kind FROM space_memberships m JOIN spaces s ON s.id=m.space_id
        WHERE m.family_id=$1 AND m.user_id=$2`,
      [familyId, spouseId],
    );
    expect(own.rows.map((row) => row.kind)).toEqual(["personal"]);
    // Прежняя семейная область остаётся со своим прежним кругом читателей: расширить её нельзя.
    await expect(database().query(
      `INSERT INTO space_memberships(family_id,space_id,user_id,role,state)
       SELECT $1,id,$2,'adult','active' FROM spaces WHERE family_id=$1 AND kind='legacy_family'`,
      [familyId, spouseId],
    )).rejects.toThrow(/AGENT_SPACE_AUDIENCE_FROZEN/u);
  });

  it("binds a newly registered external group to its own space", async () => {
    await telegramGroupAdministrationRepository.registerGroup({
      familyId, messageMode: "addressed_only", requestedBy: ownerId,
      telegramChatId: "-9101", title: "Внешняя группа", toolAllowlist: [], type: "external",
    });
    const binding = (await database().query<{ kind: string; state: string; title: string }>(
      `SELECT b.state,s.kind,s.title FROM space_bindings b JOIN spaces s ON s.id=b.space_id
        WHERE b.family_id=$1`,
      [familyId],
    )).rows;
    expect(binding).toEqual([{ kind: "group", state: "active", title: "Внешняя группа" }]);
  });

  it("binds a newly registered family chat but leaves its audience unverified", async () => {
    await telegramGroupAdministrationRepository.registerGroup({
      familyId, messageMode: "addressed_only", requestedBy: ownerId,
      telegramChatId: "-9102", title: "Пара", toolAllowlist: [], type: "family_private",
    });
    const binding = (await database().query<{ kind: string; state: string }>(
      `SELECT b.state,s.kind FROM space_bindings b JOIN spaces s ON s.id=b.space_id
        WHERE b.family_id=$1`,
      [familyId],
    )).rows;
    expect(binding).toEqual([{ kind: "legacy_family", state: "pending_verification" }]);
  });

  it("does not add a second binding when the same group is registered again", async () => {
    const registration = {
      familyId, messageMode: "addressed_only" as const, requestedBy: ownerId,
      telegramChatId: "-9103", title: "Внешняя группа", toolAllowlist: [], type: "external" as const,
    };
    await telegramGroupAdministrationRepository.registerGroup(registration);
    await telegramGroupAdministrationRepository.registerGroup({ ...registration, title: "Переименовали" });
    expect((await database().query("SELECT 1 FROM space_bindings WHERE family_id=$1", [familyId])).rowCount).toBe(1);
  });
});
