/**
 * Перенос записи в другую область расширяет круг её читателей, поэтому это отдельная операция с
 * правом `publish`, а не побочный эффект разговора. Копия самостоятельна: исходная запись, её
 * доказательства и история в целевой области не появляются.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { memoryListRepository } from "../memory-list-repository.js";
import { memoryRepository } from "../memory-repository.js";
import { listPublicationTargets, publishMemory } from "./memory-publication.js";
import {
  createTwoSpaceFixture,
  twoSpaceMemoryAuthorization,
  type TwoSpaceFixture,
} from "../spaces/two-space-fixture.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const dbDescribe = enabled ? describe : describe.skip;

let fixture: TwoSpaceFixture;

async function authorIn(spaceId: string) {
  return await twoSpaceMemoryAuthorization({
    as: fixture.owner, chat: "private", fixture, spaceId,
  });
}

async function writeIn(spaceId: string, content: string, key: string): Promise<string> {
  const claim = await memoryRepository.create(await authorIn(spaceId), {
    confirmation: "user_confirmed",
    content,
    kind: "fact",
    operationKey: key,
    scope: "family",
    sensitivity: "normal",
    source: "test:publication",
  });
  return claim.memoryRef;
}

dbDescribe("memory publication", () => {
  beforeEach(async () => {
    await database().query(
      "TRUNCATE spaces, telegram_groups, family_memberships, users, families CASCADE",
    );
    fixture = await createTwoSpaceFixture("publication");
  });
  afterAll(closeDatabase);

  it("copies the exact text into the chosen area and names its readers", async () => {
    const ref = await writeIn(fixture.householdSpaceId, "Мастер придёт во вторник", "publish-source");
    const auth = await authorIn(fixture.householdSpaceId);

    const targets = await listPublicationTargets(auth);
    expect(targets.map((target) => target.title).sort()).toEqual(["Пара", "Хозяйство"]);

    const published = await publishMemory(auth, {
      areaRef: fixture.pairSpaceId, memoryRef: ref,
    }, "publish-1");
    expect(published).toMatchObject({
      content: "Мастер придёт во вторник",
      readers: ["Владелец", "Супруга"],
      targetTitle: "Пара",
    });

    // Копия живёт в целевой области своей жизнью: у неё своя ссылка и своя область.
    expect(published.memoryRef).not.toBe(ref);
    const spouse = await twoSpaceMemoryAuthorization({
      as: fixture.spouse, chat: "private", fixture, spaceId: fixture.pairSpaceId,
    });
    const visible = await memoryListRepository.list(spouse, { limit: 10 });
    expect(visible.items.map((item) => item.content)).toEqual(["Мастер придёт во вторник"]);
  });

  it("refuses an area the person cannot publish into and a record they cannot read", async () => {
    const ref = await writeIn(fixture.householdSpaceId, "Код домофона", "publish-secret");
    const spouse = await twoSpaceMemoryAuthorization({
      as: fixture.spouse, chat: "private", fixture, spaceId: fixture.pairSpaceId,
    });

    // Чужая область не предлагается и не принимает публикацию.
    expect((await listPublicationTargets(spouse)).map((target) => target.title)).toEqual(["Пара"]);
    await expect(publishMemory(spouse, { areaRef: fixture.householdSpaceId, memoryRef: ref }, "publish-2"))
      .rejects.toThrowError(/AGENT_MEMORY_PUBLISH_DENIED/);
    // Чужая запись не публикуется и в свою область: её просто не видно.
    await expect(publishMemory(spouse, { areaRef: fixture.pairSpaceId, memoryRef: ref }, "publish-3"))
      .rejects.toThrowError(/AGENT_MEMORY_REF_INVALID/);
  });

  it("does not let a child publish into the area they read", async () => {
    await database().query(
      "UPDATE space_memberships SET role='child' WHERE space_id=$1 AND user_id=$2",
      [fixture.pairSpaceId, fixture.spouse.userId],
    );
    const child = await twoSpaceMemoryAuthorization({
      as: fixture.spouse, chat: "private", fixture, spaceId: fixture.pairSpaceId,
    });

    // Право `publish` впервые отличает роли не на бумаге: читать область ребёнок может.
    expect(await listPublicationTargets(child)).toEqual([]);
  });
});
