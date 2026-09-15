/**
 * Оговорка чтения проверяется исполнением, а не чтением её текста.
 *
 * Прежняя проверка сверяла подстроки сгенерированного SQL: предикат можно было вывернуть наизнанку,
 * не уронив ни одного утверждения. Здесь тот же самый фрагмент подставляется в настоящий запрос к
 * настоящей базе на фикстуре двух общих областей — той конфигурации, которая ломает любой предикат,
 * написанный по виду записи вместо области.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { spaceReadClause } from "./space-sql.js";
import {
  createTwoSpaceFixture,
  currentSpacePolicyVersion,
  type TwoSpaceFixture,
} from "./two-space-fixture.js";

const dbDescribe = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;

let fixture: TwoSpaceFixture;

/** $1 семья, $2 область хода, $3 человек, $4 группа чата, $5 версия политики. */
async function visibleLabels(input: {
  group?: boolean;
  person: "owner" | "spouse";
  pinned?: boolean;
  space: string | null;
  version?: number;
}): Promise<string[]> {
  const clause = spaceReadClause({
    alias: "candidate",
    parameters: { family: "$1", group: "$4", spaceId: "$2", user: "$3", version: "$5" },
    ...(input.pinned === true ? { pinned: true } : {}),
  });
  const version = input.version
    ?? (input.space === null ? 0 : await currentSpacePolicyVersion(input.space));
  const { rows } = await database().query<{ label: string }>(
    `SELECT candidate.label FROM (VALUES ('pair', $6::uuid), ('household', $7::uuid),
       ('no area', NULL::uuid)) AS candidate(label, space_id)
      WHERE ${clause} ORDER BY candidate.label`,
    [fixture.familyId, input.space, fixture[input.person].userId,
      input.group === true ? fixture.groupId : null, version,
      fixture.pairSpaceId, fixture.householdSpaceId],
  );
  return rows.map((row) => row.label);
}

dbDescribe("space read clause", () => {
  beforeEach(async () => {
    await database().query(
      "TRUNCATE spaces, telegram_groups, family_memberships, users, families CASCADE",
    );
    fixture = await createTwoSpaceFixture("space-sql");
  });
  afterAll(closeDatabase);

  it("shows a person every area of their own in their private chat", async () => {
    expect(await visibleLabels({ person: "owner", space: fixture.pairSpaceId }))
      .toEqual(["household", "pair"]);
  });

  it("does not show an area the reader does not belong to", async () => {
    // Супруга состоит только в области пары: «Хозяйство» для неё не существует.
    expect(await visibleLabels({ person: "spouse", space: fixture.pairSpaceId })).toEqual(["pair"]);
  });

  it("keeps a group chat on the area it is bound to", async () => {
    // В общем чате присутствуют другие люди, поэтому «своё» там ничего не значит.
    expect(await visibleLabels({ group: true, person: "owner", space: fixture.pairSpaceId }))
      .toEqual(["pair"]);
  });

  it("pins a mutation to the area the turn proved", async () => {
    expect(await visibleLabels({ person: "owner", pinned: true, space: fixture.pairSpaceId }))
      .toEqual(["pair"]);
  });

  it("drops the proved area when its policy changed, and keeps the other own areas", async () => {
    const stale = await currentSpacePolicyVersion(fixture.pairSpaceId) - 1;
    expect(await visibleLabels({ person: "owner", space: fixture.pairSpaceId, version: stale }))
      .toEqual(["household"]);
  });

  it("stops showing an area as soon as the membership is revoked", async () => {
    await database().query(
      "UPDATE space_memberships SET state='revoked' WHERE space_id=$1 AND user_id=$2",
      [fixture.householdSpaceId, fixture.owner.userId],
    );
    expect(await visibleLabels({ person: "owner", space: fixture.pairSpaceId })).toEqual(["pair"]);
  });

  it("hides an archived area from everyone who used to read it", async () => {
    await database().query("UPDATE spaces SET state='archived' WHERE id=$1", [fixture.householdSpaceId]);
    expect(await visibleLabels({ person: "owner", space: fixture.pairSpaceId })).toEqual(["pair"]);
  });

  it("switches itself off in the previous mode, where no row has an area yet", async () => {
    expect(await visibleLabels({ person: "owner", space: null }))
      .toEqual(["household", "no area", "pair"]);
  });
});
