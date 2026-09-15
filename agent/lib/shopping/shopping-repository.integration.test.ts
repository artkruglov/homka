/**
 * Список покупок ведут вдвоём: у пункта нет исполнителя, отметка «куплено» несёт автора и время,
 * параллельные добавления не теряются, а случайную отметку можно снять. Аудиторию задаёт область.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import { closeDatabase, database } from "../database.js";
import type { MemoryAuthorization } from "../memory-context.js";
import { shoppingRepository as shopping } from "./shopping-repository.js";
import {
  createTwoSpaceFixture,
  currentSpacePolicyVersion,
  type TwoSpaceFixture,
} from "../spaces/two-space-fixture.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const dbDescribe = enabled ? describe : describe.skip;

let fixture: TwoSpaceFixture;

function auth(
  as: TwoSpaceFixture["owner"],
  options: { group?: boolean; space?: string } = {},
): Promise<MemoryAuthorization> {
  return (async () => ({
    familyId: fixture.familyId,
    groupId: options.group === true ? fixture.groupId : null,
    role: "member",
    scopes: options.group === true ? ["family"] : ["personal", "family"],
    ...(options.space === undefined
      ? {}
      : { space: { policyVersion: await currentSpacePolicyVersion(options.space), spaceId: options.space } }),
    telegramActorId: as.telegramUserId,
    telegramActorKind: "telegram_user",
    telegramUserId: as.telegramUserId,
    userId: as.userId,
  }))() as Promise<MemoryAuthorization>;
}

dbDescribe("shopping list", () => {
  beforeEach(async () => {
    await database().query(
      "TRUNCATE shopping_items, spaces, telegram_groups, family_memberships, users, families CASCADE",
    );
    fixture = await createTwoSpaceFixture("shopping");
  });
  afterAll(closeDatabase);

  it("asks the rights of the area the item belongs to, not of the chat it is changed from", async () => {
    // Право писать проверялось только в активной области хода. Ребёнок, у которого в своей
    // области права есть, а в семейной нет, снимал бы пункт семейного списка из личного чата.
    const ownerInPair = await auth(fixture.owner, { space: fixture.pairSpaceId });
    const added = await shopping.execute(ownerInPair,
      { action: "add", listName: "Продукты", title: "Молоко" }, randomUUID());
    await database().query(
      "UPDATE space_memberships SET role='child' WHERE space_id=$1 AND user_id=$2",
      [fixture.pairSpaceId, fixture.spouse.userId],
    );
    // Своя область у супруги остаётся её: в ней права не тронуты.
    const spousePersonal = (await database().query<{ id: string }>(
      `INSERT INTO spaces(family_id,kind,title,owner_user_id,state)
       VALUES($1,'personal','Своё',$2,'forming') RETURNING id`,
      [fixture.familyId, fixture.spouse.userId],
    )).rows[0]!.id;
    await database().query(
      `INSERT INTO space_memberships(family_id,space_id,user_id,role,state)
       VALUES($1,$2,$3,'manager','active')`,
      [fixture.familyId, spousePersonal, fixture.spouse.userId],
    );
    await database().query("UPDATE spaces SET state='active' WHERE id=$1", [spousePersonal]);

    const spouseAtHome = await auth(fixture.spouse, { space: spousePersonal });
    await expect(shopping.execute(spouseAtHome,
      { action: "remove", id: added.item!.id, version: added.item!.version }, randomUUID()))
      .rejects.toThrow(/AGENT_SPACE_ACCESS_DENIED|AGENT_SHOPPING_ACCESS_DENIED/u);
    const stored = await database().query(
      "SELECT 1 FROM shopping_items WHERE id=$1 AND removed_at IS NULL", [added.item!.id]);
    expect(stored.rowCount).toBe(1);
  });

  it("keeps both parallel additions and marks a purchase with its author", async () => {
    const owner = await auth(fixture.owner);
    const spouse = await auth(fixture.spouse);
    const first = await shopping.execute(owner, { action: "add", listName: "Покупки", title: "Молоко", quantity: "2 пачки" }, randomUUID());
    const second = await shopping.execute(spouse, { action: "add", listName: "Покупки", title: "Молоко" }, randomUUID());

    // Одинаковые названия не сливаются: два пакета молока это намеренно два пункта.
    expect(first.item!.id).not.toBe(second.item!.id);
    const list = await shopping.execute(spouse, { action: "list", listName: "Покупки" }, "read");
    expect(list.items!.map((item) => item.title)).toEqual(["Молоко", "Молоко"]);

    const bought = await shopping.execute(spouse, {
      action: "buy", id: first.item!.id, version: first.item!.version,
    }, randomUUID());
    expect(bought.item).toMatchObject({ boughtBy: "Супруга" });
    expect(bought.item!.boughtAt).not.toBeNull();
    // Куплённое уходит из списка к покупке, но остаётся видимым отдельным видом.
    const open = await shopping.execute(owner, { action: "list" }, "read");
    expect(open.items!.map((item) => item.id)).toEqual([second.item!.id]);
  });

  it("undoes a mistaken purchase and refuses a stale version", async () => {
    const owner = await auth(fixture.owner);
    const item = await shopping.execute(owner, { action: "add", listName: "Покупки", title: "Хлеб" }, randomUUID());
    const bought = await shopping.execute(owner, {
      action: "buy", id: item.item!.id, version: item.item!.version,
    }, randomUUID());

    await expect(shopping.execute(owner, {
      action: "unbuy", id: item.item!.id, version: item.item!.version,
    }, randomUUID())).rejects.toThrowError(/AGENT_SHOPPING_VERSION_STALE/);
    const undone = await shopping.execute(owner, {
      action: "unbuy", id: item.item!.id, version: bought.item!.version,
    }, randomUUID());
    expect(undone.item).toMatchObject({ boughtAt: null, boughtBy: null });
  });

  it("replays one operation key without adding a second item", async () => {
    const owner = await auth(fixture.owner);
    const key = randomUUID();
    const first = await shopping.execute(owner, { action: "add", listName: "Покупки", title: "Яйца" }, key);
    const again = await shopping.execute(owner, { action: "add", listName: "Покупки", title: "Яйца" }, key);

    expect(again).toMatchObject({ replayed: true });
    expect(again.item!.id).toBe(first.item!.id);
    const list = await shopping.execute(owner, { action: "list" }, "read");
    expect(list.items).toHaveLength(1);
  });

  it("shows a group chat only the list of its own area", async () => {
    const inPair = await auth(fixture.owner, { group: true, space: fixture.pairSpaceId });
    await shopping.execute(inPair, { action: "add", listName: "Покупки", title: "Творог" }, randomUUID());
    const household = await auth(fixture.owner, { space: fixture.householdSpaceId });
    await shopping.execute(household, { action: "add", listName: "Покупки", title: "Лампочки" }, randomUUID());

    const groupList = await shopping.execute(inPair, { action: "list" }, "read");
    expect(groupList.items!.map((item) => item.title)).toEqual(["Творог"]);
    // В личном чате человек видит списки всех своих областей: он состоит в обеих.
    const privateList = await shopping.execute(household, { action: "list" }, "read");
    expect(privateList.items!.map((item) => item.title).sort()).toEqual(["Лампочки", "Творог"]);
    expect(privateList.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "Творог", source: "Пара", spaceId: fixture.pairSpaceId }),
      expect.objectContaining({ title: "Лампочки", source: "Хозяйство", spaceId: fixture.householdSpaceId }),
    ]));
  });

  it("refuses a chat that is not a trusted one", async () => {
    const external = { ...await auth(fixture.owner), role: "external" as const };
    await expect(shopping.execute(external, { action: "list" }, "read"))
      .rejects.toThrowError(/AGENT_SHOPPING_ACCESS_DENIED/);
  });
});
