/**
 * Замыкание конфликтов состоит из трёх отдельных запросов авторизации, и пропуск любого из них
 * открывает содержимое чужой области: конфликт показывает обе версии сразу.
 *
 * Читатель здесь супруга: она состоит только в области пары, поэтому «Хозяйство» для неё чужое.
 * Своё из соседней области человек в личном чате видит намеренно — это проверяет соседний файл.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { memoryRepository } from "../memory-repository.js";
import { memoryRetrievalRepository } from "../memory-retrieval-repository.js";
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
let pairClaimId: string;
let householdClaimId: string;

function zeroVector(): number[] {
  return Array.from({ length: 384 }, (_, index) => (index === 0 ? 1 : 0));
}

async function writeFact(spaceId: string, content: string, key: string): Promise<string> {
  const author = await twoSpaceMemoryAuthorization({
    as: fixture.owner, chat: "private", fixture, spaceId,
  });
  const claim = await memoryRepository.create({ ...author, space: undefined }, {
    confirmation: "user_confirmed",
    content,
    kind: "fact",
    operationKey: key,
    provenance: { sessionId: "two-space-retrieval", turnId: key },
    scope: "family",
    sensitivity: "normal",
    source: "test:two-space-retrieval",
  });
  await database().query("UPDATE memory_items SET space_id=$2 WHERE id=$1", [claim.id, spaceId]);
  return claim.id;
}

async function searchIn(spaceId: string, query: string) {
  const auth = await twoSpaceMemoryAuthorization({
    as: fixture.spouse, chat: "private", fixture, spaceId,
  });
  return memoryRetrievalRepository.searchWithConflictClosure(auth, query, zeroVector());
}

dbDescribe("retrieval across two shared spaces", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE families,users CASCADE");
    fixture = await createTwoSpaceFixture("retrieval");
    pairClaimId = await writeFact(fixture.pairSpaceId, "Код домофона 1234", "two-space-pair-code");
    householdClaimId = await writeFact(fixture.householdSpaceId, "Код домофона 9876", "two-space-household-code");
  });
  afterAll(closeDatabase);

  it("never returns an area of somebody else among the results", async () => {
    const found = await searchIn(fixture.pairSpaceId, "код домофона");
    expect(found.results.map((result) => result.memory.content)).toEqual(["Код домофона 1234"]);
  });

  it("withholds a claim whose conflicting partner lives in another space", async () => {
    await database().query(
      `INSERT INTO claim_conflicts
         (claim_a_id, claim_b_id, family_id, scope, scope_partition_key, detection_method)
       VALUES (LEAST($1::uuid,$2::uuid), GREATEST($1::uuid,$2::uuid), $3, 'family', $3,
               'deterministic_guard')`,
      [pairClaimId, householdClaimId, fixture.familyId],
    );

    const found = await searchIn(fixture.pairSpaceId, "код домофона");

    // Недоступная вторая версия обязана скрыть и видимую: иначе одна сторона конфликта выдаёт,
    // что у записи есть другая версия, а замыкание показало бы и её содержимое.
    expect(found.conflicts).toEqual([]);
    expect(found.results.map((result) => result.memory.content)).toEqual([]);
  });
});
