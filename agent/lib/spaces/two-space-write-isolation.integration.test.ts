/**
 * Запись памяти обязана попасть в доказанную область, а склейка одинакового содержимого —
 * останавливаться на её границе: иначе вторая область молча становится продолжением первой.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
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

async function write(spaceId: string, content: string, key: string, attribute?: string) {
  const auth = await twoSpaceMemoryAuthorization({
    as: fixture.owner, chat: "private", fixture, spaceId,
  });
  return memoryRepository.create(auth, {
    ...(attribute === undefined ? {} : { attribute }),
    confirmation: "user_confirmed",
    content,
    kind: "fact",
    operationKey: key,
    provenance: { sessionId: "two-space-write", turnId: key },
    scope: "family",
    sensitivity: "normal",
    source: "test:two-space-write",
  });
}

dbDescribe("writing memory in two shared spaces", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE families,users CASCADE");
    fixture = await createTwoSpaceFixture("writes");
  });
  afterAll(closeDatabase);

  it("stores a record in the space the turn proved", async () => {
    const claim = await write(fixture.pairSpaceId, "Няня приходит по средам", "write-pair");
    const stored = (await database().query<{ space_id: string }>(
      "SELECT space_id FROM memory_items WHERE id=$1", [claim.id],
    )).rows[0]!;
    expect(stored.space_id).toBe(fixture.pairSpaceId);
  });

  it("keeps identical content in two spaces as two records", async () => {
    // Точная склейка ищет по разделу; без области она вернула бы первую запись как «уже есть»,
    // и вторая область получила бы ссылку на чужую строку.
    const first = await write(fixture.pairSpaceId, "Код домофона 1234", "write-dup-pair");
    const second = await write(fixture.householdSpaceId, "Код домофона 1234", "write-dup-household");
    expect(second.id).not.toBe(first.id);
    const spaces = (await database().query<{ space_id: string }>(
      "SELECT space_id FROM memory_items WHERE content='Код домофона 1234' ORDER BY created_at",
    )).rows.map((row) => row.space_id);
    expect(spaces).toEqual([fixture.pairSpaceId, fixture.householdSpaceId]);
  });

  it("does not supersede the same slot in the neighbouring space", async () => {
    const kept = await write(fixture.householdSpaceId, "Мусор выносим по вторникам", "slot-household", "мусор");
    await write(fixture.pairSpaceId, "Мусор выносим по четвергам", "slot-pair", "мусор");
    const status = (await database().query<{ claim_status: string }>(
      "SELECT claim_status FROM memory_items WHERE id=$1", [kept.id],
    )).rows[0]!;
    expect(status.claim_status).toBe("active");
  });

  it("hands the record's area down to everything written beneath it", async () => {
    const claim = await write(fixture.pairSpaceId, "Ключи у соседки", "write-children");
    const children = (await database().query<{ relation: string; space_id: string | null }>(
      `SELECT 'evidence' AS relation, space_id FROM claim_evidence WHERE claim_id=$1
       UNION ALL SELECT 'ref', space_id FROM memory_item_refs WHERE memory_item_id=$1
       UNION ALL SELECT 'embedding_job', space_id FROM memory_embedding_jobs WHERE memory_item_id=$1
       UNION ALL SELECT 'operation', space_id FROM memory_mutation_operations WHERE memory_item_id=$1`,
      [claim.id],
    )).rows;
    // Перечислять места вставки значит однажды забыть одно: область наследуется схемой.
    expect(children.length).toBeGreaterThanOrEqual(3);
    expect(children.filter((row) => row.space_id !== fixture.pairSpaceId)).toEqual([]);
  });

  it("refuses to write into a space the author no longer belongs to", async () => {
    const auth = await twoSpaceMemoryAuthorization({
      as: fixture.owner, chat: "private", fixture, spaceId: fixture.householdSpaceId,
    });
    await database().query(
      "UPDATE space_memberships SET state='revoked' WHERE space_id=$1 AND user_id=$2",
      [fixture.householdSpaceId, fixture.owner.userId],
    );
    await expect(memoryRepository.create(auth, {
      confirmation: "user_confirmed",
      content: "Запись после отзыва",
      kind: "fact",
      operationKey: "write-revoked",
      provenance: { sessionId: "two-space-write", turnId: "write-revoked" },
      scope: "family",
      sensitivity: "normal",
      source: "test:two-space-write",
    })).rejects.toMatchObject({ code: "AGENT_SPACE_ACCESS_DENIED" });
  });
});
