/**
 * Нити памяти читаются четырьмя модулями. В личном чате человек видит нити всех своих областей;
 * чужая область закрыта в каждом из них, и отказ одинаков для «нет доступа» и «не существует».
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const queryVector = vi.hoisted(() => [1, ...Array.from({ length: 383 }, () => 0)]);
vi.mock("../memory-embedding-client.js", () => ({ embedMemoryQuery: async () => queryVector }));

import { closeDatabase, database } from "../database.js";
import { memoryThreadQueryRepository } from "../memory-thread-query-repository.js";
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
let householdThreadRef: string;

async function insertThread(spaceId: string, title: string): Promise<string> {
  // Нить обязана иметь ровно одну опору: здесь это субъект-человек.
  const inserted = await database().query<{ thread_ref: string }>(
    `INSERT INTO memory_threads(family_id,scope,scope_partition_key,title,purpose,space_id,subject_user_id)
     VALUES($1,'family',$1,$2,$3,$4,$5) RETURNING thread_ref`,
    [fixture.familyId, title, `Зачем: ${title}`, spaceId, fixture.owner.userId],
  );
  return inserted.rows[0]!.thread_ref;
}

async function authFor(spaceId: string, as = fixture.owner) {
  return twoSpaceMemoryAuthorization({ as, chat: "private", fixture, spaceId });
}

dbDescribe("memory threads across two shared spaces", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE families,users CASCADE");
    fixture = await createTwoSpaceFixture("threads");
    await insertThread(fixture.pairSpaceId, "Отпуск вдвоём");
    householdThreadRef = await insertThread(fixture.householdSpaceId, "Ремонт кухни");
  });
  afterAll(closeDatabase);

  it("lists the threads of every area of its reader and nobody else's", async () => {
    const mine = await memoryThreadQueryRepository.list(await authFor(fixture.pairSpaceId), { limit: 10 });
    expect(mine.items.map((item) => item.title).sort()).toEqual(["Отпуск вдвоём", "Ремонт кухни"]);

    // Супруга состоит только в области пары: «Хозяйство» ей не своё ни в каком чате.
    const spouse = await memoryThreadQueryRepository.list(
      await authFor(fixture.pairSpaceId, fixture.spouse), { limit: 10 },
    );
    expect(spouse.items.map((item) => item.title)).toEqual(["Отпуск вдвоём"]);
  });

  it("refuses to open a thread of an area the reader never joined", async () => {
    // Отказ одинаков для «нет доступа» и «не существует»: иначе ссылка подтверждает существование.
    await expect(memoryThreadQueryRepository.read(
      await authFor(fixture.pairSpaceId, fixture.spouse), householdThreadRef, { limit: 10 },
    )).rejects.toMatchObject({ code: "AGENT_MEMORY_THREAD_NOT_FOUND" });
    await expect(memoryThreadQueryRepository.read(
      await authFor(fixture.pairSpaceId), householdThreadRef, { limit: 10 },
    )).resolves.toMatchObject({ thread: expect.objectContaining({ title: "Ремонт кухни" }) });
  });

  it("finds nothing by a title that lives in an area the reader never joined", async () => {
    const found = await memoryThreadQueryRepository.search(
      await authFor(fixture.pairSpaceId, fixture.spouse), "ремонт кухни", 10,
    );
    expect(found).toEqual([]);
  });
});
