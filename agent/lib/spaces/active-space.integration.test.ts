/**
 * Читать в личном чате человек может все свои области, но новая запись обязана попасть ровно в
 * одну. Поэтому активная область выбирается явно, проверяется на каждом чтении и никогда не
 * выводится из содержания разговора.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { PoolClient } from "pg";

import { closeDatabase, database } from "../database.js";
import { boundChatSpace, listOwnSpaces, readActiveSpace, setActiveSpace } from "./active-space.js";
import { resolveTurnSpace } from "./turn-space-selection.js";
import { createTwoSpaceFixture, type TwoSpaceFixture } from "./two-space-fixture.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const dbDescribe = enabled ? describe : describe.skip;

let fixture: TwoSpaceFixture;
let personalSpaceId: string;

async function transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

function privateTurn(as = fixture.owner) {
  return resolveTurnSpace({
    chatType: "private", familyId: fixture.familyId, groupId: null, userId: as.userId,
  });
}

dbDescribe("active area of a private chat", () => {
  beforeEach(async () => {
    await database().query(
      "TRUNCATE spaces, telegram_groups, family_memberships, users, families CASCADE",
    );
    fixture = await createTwoSpaceFixture("active-space");
    await database().query(
      "UPDATE family_space_runtime SET mode='spaces', cutover_at=now(), reason='Переход' WHERE family_id=$1",
      [fixture.familyId],
    );
    personalSpaceId = (await database().query<{ id: string }>(
      `INSERT INTO spaces(family_id,kind,title,owner_user_id) VALUES($1,'personal','Личное',$2)
       RETURNING id`, [fixture.familyId, fixture.owner.userId],
    )).rows[0]!.id;
    await database().query(
      "INSERT INTO space_memberships(family_id,space_id,user_id,role,state) VALUES($1,$2,$3,'manager','active')",
      [fixture.familyId, personalSpaceId, fixture.owner.userId],
    );
    await database().query("UPDATE spaces SET state='active' WHERE id=$1", [personalSpaceId]);
  });
  afterAll(closeDatabase);

  it("starts in the personal area and lists every area of this person", async () => {
    await expect(privateTurn()).resolves.toMatchObject({ spaceId: personalSpaceId });

    const areas = await transaction((client) =>
      listOwnSpaces(client, fixture.familyId, fixture.owner.userId));
    expect(areas.map((area) => area.title)).toEqual(["Личное", "Пара", "Хозяйство"]);
    expect(areas.filter((area) => area.active)).toEqual([]);
    // «Кто это увидит» отвечается списком читателей области, а не типом чата и не родством.
    expect(areas.map((area) => area.readers)).toEqual([
      ["Владелец"], ["Владелец", "Супруга"], ["Владелец"],
    ]);

    // Супруга состоит только в области пары: чужие области ей не предлагаются.
    const spouse = await transaction((client) =>
      listOwnSpaces(client, fixture.familyId, fixture.spouse.userId));
    expect(spouse.map((area) => area.title)).toEqual(["Пара"]);
  });

  it("writes the next records into the chosen area", async () => {
    await transaction((client) => setActiveSpace(client, {
      familyId: fixture.familyId, spaceId: fixture.householdSpaceId, userId: fixture.owner.userId,
    }));

    await expect(privateTurn()).resolves.toMatchObject({ spaceId: fixture.householdSpaceId });
    const areas = await transaction((client) =>
      listOwnSpaces(client, fixture.familyId, fixture.owner.userId));
    expect(areas.find((area) => area.active)?.title).toBe("Хозяйство");
  });

  it("answers a group chat with the area its binding gives it", async () => {
    const bound = await transaction((client) =>
      boundChatSpace(client, fixture.familyId, fixture.groupId));
    expect(bound).toMatchObject({ readers: ["Владелец", "Супруга"], title: "Пара" });

    // Неподтверждённый состав чата области не даёт: карточка честно скажет, что её нет.
    await database().query(
      "UPDATE space_bindings SET state='pending_verification' WHERE group_id=$1", [fixture.groupId],
    );
    await expect(transaction((client) =>
      boundChatSpace(client, fixture.familyId, fixture.groupId))).resolves.toBeNull();
  });

  it("refuses an area this person does not belong to and keeps the previous choice", async () => {
    await expect(transaction((client) => setActiveSpace(client, {
      familyId: fixture.familyId, spaceId: fixture.householdSpaceId, userId: fixture.spouse.userId,
    }))).rejects.toThrowError(/AGENT_SPACE_NOT_AVAILABLE/);
  });

  it("falls back to the personal area when the choice stops being valid", async () => {
    await transaction((client) => setActiveSpace(client, {
      familyId: fixture.familyId, spaceId: fixture.householdSpaceId, userId: fixture.owner.userId,
    }));
    await database().query(
      "UPDATE space_memberships SET state='revoked' WHERE space_id=$1 AND user_id=$2",
      [fixture.householdSpaceId, fixture.owner.userId],
    );

    await expect(transaction((client) =>
      readActiveSpace(client, fixture.familyId, fixture.owner.userId))).resolves.toBeNull();
    await expect(privateTurn()).resolves.toMatchObject({ spaceId: personalSpaceId });
  });
});
