/**
 * Аудиторию чата доказывают поимённо и замыкают счётчиком: проверка по именам говорит, что
 * названные люди в чате есть, и ничего не говорит о том, что в нём нет никого больше.
 *
 * Расхождение счётчика — это вход или выход человека, поэтому оно снимает разрешение целиком:
 * доказательство исчезает, привязка возвращается в неподтверждённое состояние, а версия политики
 * растёт сама и делает устаревшим всё, что на ней держалось.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import {
  AUDIENCE_PROOF_FRESHNESS_MILLISECONDS,
  isAudienceProven,
  noteObservedMemberCount,
  recordAudienceProof,
} from "./telegram-audience-proof.js";
import {
  createTwoSpaceFixture,
  currentSpacePolicyVersion,
  type TwoSpaceFixture,
} from "./two-space-fixture.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const dbDescribe = enabled ? describe : describe.skip;
// Отметка проверки ставится часами базы, поэтому свежесть считается от них же, а не от
// синтетического времени теста.
const NOW = new Date();

async function transaction<T>(run: (client: import("pg").PoolClient) => Promise<T>): Promise<T> {
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

async function prove(fixture: TwoSpaceFixture, roster: readonly string[]): Promise<number> {
  const policyVersion = await currentSpacePolicyVersion(fixture.pairSpaceId);
  await transaction((client) => recordAudienceProof(client, {
    botIsAdministrator: true,
    confirmedBy: fixture.owner.userId,
    declaredBotCount: 1,
    familyId: fixture.familyId,
    groupId: fixture.groupId,
    observedMemberCount: roster.length + 1,
    policyVersion,
    roster,
    spaceId: fixture.pairSpaceId,
  }));
  return policyVersion;
}

function proven(fixture: TwoSpaceFixture, policyVersion: number, now = NOW) {
  return transaction((client) => isAudienceProven(client, {
    groupId: fixture.groupId, now, policyVersion, spaceId: fixture.pairSpaceId,
  }));
}

dbDescribe("telegram chat audience proof", () => {
  let fixture: TwoSpaceFixture;

  beforeEach(async () => {
    await database().query(
      "TRUNCATE spaces, telegram_groups, family_memberships, users, families CASCADE",
    );
    fixture = await createTwoSpaceFixture("audience-proof");
  });
  afterAll(closeDatabase);

  it("refuses an unclosed audience at the schema level", async () => {
    await expect(database().query(
      `INSERT INTO telegram_chat_audience_proofs
         (group_id, family_id, space_id, space_policy_version, roster, declared_bot_count,
          observed_member_count, bot_is_administrator, confirmed_by)
       VALUES ($1,$2,$3,1,ARRAY[$4]::uuid[],1,7,true,$4)`,
      [fixture.groupId, fixture.familyId, fixture.pairSpaceId, fixture.owner.userId],
    )).rejects.toThrowError(/telegram_chat_audience_proofs_check/);
  });

  it("proves a confirmed roster and stops trusting it after the freshness window", async () => {
    const version = await prove(fixture, [fixture.owner.userId, fixture.spouse.userId]);

    await expect(proven(fixture, version)).resolves.toBe(true);
    await expect(proven(fixture, version + 1)).resolves.toBe(false);
    await expect(proven(fixture, version, new Date(NOW.getTime() + AUDIENCE_PROOF_FRESHNESS_MILLISECONDS + 60_000)))
      .resolves.toBe(false);
  });

  it("revokes the binding when the observed member count no longer matches", async () => {
    const version = await prove(fixture, [fixture.owner.userId, fixture.spouse.userId]);
    const later = new Date(NOW.getTime() + 60_000);

    await expect(transaction((client) => noteObservedMemberCount(client, {
      count: 3, familyId: fixture.familyId, groupId: fixture.groupId, now: later,
    }))).resolves.toBe("matched");
    await expect(proven(fixture, version, later)).resolves.toBe(true);

    await expect(transaction((client) => noteObservedMemberCount(client, {
      count: 4, familyId: fixture.familyId, groupId: fixture.groupId, now: later,
    }))).resolves.toBe("revoked");
    await expect(proven(fixture, version, later)).resolves.toBe(false);
    const binding = await database().query<{ state: string }>(
      "SELECT state FROM space_bindings WHERE group_id=$1", [fixture.groupId],
    );
    expect(binding.rows[0]!.state).toBe("pending_verification");
    // Снятие разрешения само поднимает версию политики, поэтому прежний контекст хода устарел.
    await expect(currentSpacePolicyVersion(fixture.pairSpaceId)).resolves.toBeGreaterThan(version);
  });
});
