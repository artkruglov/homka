/**
 * Две области одной семьи с одинаковым видом записей: отличить их можно только по `space_id`.
 *
 * Границы две, и они разные. Групповой чат читает ровно привязанную к нему область: его аудитория
 * шире одного человека. Личный чат читает все области **своего** человека: его аудитория это он
 * сам, и разделение личного, пары и работы он держит в собственной голове. Чужая область не
 * открывается нигде, а изменение всегда адресует доказанную областью запись.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { memoryListRepository } from "../memory-list-repository.js";
import { memoryRepository } from "../memory-repository.js";
import {
  createTwoSpaceFixture,
  twoSpaceMemoryAuthorization,
  type TwoSpaceFixture,
} from "./two-space-fixture.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const dbDescribe = enabled ? describe : describe.skip;

let fixture: TwoSpaceFixture;

async function writeFact(spaceId: string, content: string, key: string): Promise<void> {
  const author = await twoSpaceMemoryAuthorization({
    as: fixture.owner, chat: "private", fixture, spaceId,
  });
  const claim = await memoryRepository.create({ ...author, space: undefined }, {
    confirmation: "user_confirmed",
    content,
    kind: "fact",
    operationKey: key,
    provenance: { sessionId: "two-space-session", turnId: key },
    scope: "family",
    sensitivity: "normal",
    source: "test:two-space",
  });
  // Так запись выглядит после бэкфилла; перевод самой записи в область — отдельная работа.
  await database().query("UPDATE memory_items SET space_id=$2 WHERE id=$1", [claim.id, spaceId]);
}

async function visible(input: Parameters<typeof twoSpaceMemoryAuthorization>[0]): Promise<string[]> {
  const auth = await twoSpaceMemoryAuthorization(input);
  const page = await memoryListRepository.list(auth, { limit: 10 });
  return page.items.map((item) => item.content).sort();
}

dbDescribe("two shared spaces of one family", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE families,users CASCADE");
    fixture = await createTwoSpaceFixture();
    await writeFact(fixture.pairSpaceId, "Договорённость пары", "two-space-pair");
    await writeFact(fixture.householdSpaceId, "Заметка по хозяйству", "two-space-household");
  });
  afterAll(closeDatabase);

  it("shows a group chat only the space its chat is bound to", async () => {
    await expect(visible({ as: fixture.owner, chat: "group", fixture, spaceId: fixture.pairSpaceId }))
      .resolves.toEqual(["Договорённость пары"]);
  });

  it("shows nothing in a group chat for a space that chat is not bound to", async () => {
    await expect(visible({ as: fixture.owner, chat: "group", fixture, spaceId: fixture.householdSpaceId }))
      .resolves.toEqual([]);
  });

  it("refuses a context naming a space the reader never joined", async () => {
    // Супруга не состоит в «Хозяйстве»: даже с виду правильный контекст не открывает его записи,
    // и объединение своих областей ничего к ним не добавляет — своей эта область ей не является.
    await expect(visible({ as: fixture.spouse, chat: "private", fixture, spaceId: fixture.householdSpaceId }))
      .resolves.toEqual(["Договорённость пары"]);
    await expect(visible({ as: fixture.spouse, chat: "private", fixture, spaceId: fixture.pairSpaceId }))
      .resolves.toEqual(["Договорённость пары"]);
  });

  it("closes a group chat whose binding is no longer active", async () => {
    await database().query("UPDATE space_bindings SET state='paused' WHERE group_id=$1", [fixture.groupId]);
    await expect(visible({ as: fixture.owner, chat: "group", fixture, spaceId: fixture.pairSpaceId }))
      .resolves.toEqual([]);
  });

  it("cannot delete a record named by a reference from another space", async () => {
    const householdRef = (await database().query<{ memory_ref: string }>(
      `SELECT ref.memory_ref FROM memory_item_refs ref JOIN memory_items item ON item.id=ref.memory_item_id
        WHERE item.space_id=$1`,
      [fixture.householdSpaceId],
    )).rows[0]!.memory_ref;
    const auth = await twoSpaceMemoryAuthorization({
      as: fixture.owner, chat: "private", fixture, spaceId: fixture.pairSpaceId,
    });

    // Ссылка непрозрачна, но это способность, а не право: из другой области она не находит ничего.
    await expect(memoryRepository.deleteByRef(auth, householdRef, "cross-space-delete"))
      .rejects.toMatchObject({ code: "AGENT_MEMORY_NOT_FOUND" });
  });

  it("gives a private chat every area of its own person", async () => {
    // «Как у меня в голове»: человек в личном чате видит и пару, и хозяйство, потому что состоит
    // в обеих. Активная область определяет, куда пойдёт новая запись, а не что можно прочитать.
    const both = ["Договорённость пары", "Заметка по хозяйству"];
    await expect(visible({ as: fixture.owner, chat: "private", fixture, spaceId: fixture.pairSpaceId }))
      .resolves.toEqual(both);
    await expect(visible({ as: fixture.owner, chat: "private", fixture, spaceId: fixture.householdSpaceId }))
      .resolves.toEqual(both);
  });

  it("stops showing a revoked area in the same private chat", async () => {
    await database().query(
      "UPDATE space_memberships SET state='revoked' WHERE space_id=$1 AND user_id=$2",
      [fixture.householdSpaceId, fixture.owner.userId],
    );

    await expect(visible({ as: fixture.owner, chat: "private", fixture, spaceId: fixture.pairSpaceId }))
      .resolves.toEqual(["Договорённость пары"]);
  });
});
