/**
 * История проактивных доставок подмешивается в промпт следующего хода, поэтому она проверяется и
 * на чтении: отправленное прежней аудитории того же самого чата не должно попадать в ход,
 * доказавший другую область. Сама доставка наследует область своего источника — ход, который
 * завёл напоминание, к моменту отправки давно закончился.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { sessionRepository } from "../sessions/session-repository.js";
import {
  createTwoSpaceFixture,
  currentSpacePolicyVersion,
  type TwoSpaceFixture,
} from "../spaces/two-space-fixture.js";
import { proactiveDeliveryRepository } from "./proactive-delivery-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const dbDescribe = enabled ? describe : describe.skip;

const NOW = new Date("2026-09-11T12:00:00.000Z");
const DELIVERED_AT = new Date("2026-09-11T09:00:00.000Z");

async function insertReminder(fixture: TwoSpaceFixture, spaceId: string): Promise<string> {
  const inserted = await database().query<{ id: string }>(
    `INSERT INTO reminders
       (family_id, author_user_id, group_id, scope, content, timezone, telegram_chat_id,
        recurrence_anchor_local, due_at, available_at, space_id)
     VALUES ($1,$2,$3,'family','Забрать посылку','Europe/Moscow',$4,
             $5::timestamptz AT TIME ZONE 'Europe/Moscow',$5,$5,$6)
     RETURNING id`,
    [fixture.familyId, fixture.owner.userId, fixture.groupId, fixture.telegramChatId, DELIVERED_AT, spaceId],
  );
  return inserted.rows[0]!.id;
}

async function recordDelivery(fixture: TwoSpaceFixture, sourceId: string, messageId: string) {
  await proactiveDeliveryRepository.record({
    content: "Напоминание:\n\nЗабрать посылку",
    deliveredAt: DELIVERED_AT,
    familyId: fixture.familyId,
    groupId: fixture.groupId,
    messageThreadId: null,
    ownerUserId: null,
    scheduledFor: DELIVERED_AT,
    scope: "family",
    sourceId,
    sourceKind: "reminder",
    telegramChatId: fixture.telegramChatId,
    telegramMessageId: messageId,
    title: null,
  });
}

async function prepareGroupTurn(fixture: TwoSpaceFixture, spaceId: string) {
  return await sessionRepository.prepareTurn({
    baseContinuationToken: `${fixture.telegramChatId}::group`,
    familyId: fixture.familyId,
    groupId: fixture.groupId,
    kind: "canonical",
    now: NOW,
    scope: "family",
    spaceContext: {
      chat: { groupId: fixture.groupId, type: "supergroup" },
      familyId: fixture.familyId,
      spaceId,
      userId: fixture.owner.userId,
    },
    telegramForumTopicId: null,
    userId: null,
  });
}

function pendingFor(fixture: TwoSpaceFixture, applicationSessionId: string) {
  return proactiveDeliveryRepository.listPendingContext({
    applicationSessionId,
    familyId: fixture.familyId,
    groupId: fixture.groupId,
    messageThreadId: null,
    now: NOW,
    ownerUserId: null,
    scope: "family",
    telegramChatId: fixture.telegramChatId,
  });
}

async function rebindGroup(fixture: TwoSpaceFixture, spaceId: string): Promise<void> {
  await database().query(
    "UPDATE space_bindings SET state='pending_verification' WHERE group_id=$1", [fixture.groupId],
  );
  await database().query(
    "UPDATE space_bindings SET space_id=$2 WHERE group_id=$1", [fixture.groupId, spaceId],
  );
  await database().query(
    "UPDATE space_bindings SET state='active' WHERE group_id=$1", [fixture.groupId],
  );
}

async function listFor(fixture: TwoSpaceFixture, spaceId: string, cursor?: string) {
  return await proactiveDeliveryRepository.list({
    ...(cursor === undefined ? {} : { cursor }),
    deliveredAfter: null,
    deliveredBefore: null,
    familyId: fixture.familyId,
    groupId: fixture.groupId,
    limit: 1,
    messageThreadId: null,
    ownerUserId: null,
    query: null,
    scope: "family",
    sourceKind: null,
    space: { policyVersion: await currentSpacePolicyVersion(spaceId), spaceId },
    telegramChatId: fixture.telegramChatId,
  });
}

dbDescribe("proactive delivery area", () => {
  let fixture: TwoSpaceFixture;

  beforeEach(async () => {
    await database().query(
      `TRUNCATE proactive_deliveries, reminders, conversation_sessions, spaces, telegram_groups,
       family_memberships, users, families CASCADE`,
    );
    fixture = await createTwoSpaceFixture("proactive-space");
    await database().query(
      "UPDATE family_space_runtime SET mode='spaces', cutover_at=now(), reason='Переход' WHERE family_id=$1",
      [fixture.familyId],
    );
  });
  afterAll(async () => closeDatabase());

  it("gives a delivery the area of the source that produced it", async () => {
    const reminderId = await insertReminder(fixture, fixture.pairSpaceId);
    await recordDelivery(fixture, reminderId, "5001");

    const stored = await database().query<{ space_id: string | null }>(
      "SELECT space_id FROM proactive_deliveries WHERE source_id=$1", [reminderId],
    );
    expect(stored.rows[0]!.space_id).toBe(fixture.pairSpaceId);
  });

  it("keeps the neighbouring area's deliveries out of the next turn's context", async () => {
    const reminderId = await insertReminder(fixture, fixture.pairSpaceId);
    await recordDelivery(fixture, reminderId, "5002");

    const own = await prepareGroupTurn(fixture, fixture.pairSpaceId);
    await expect(pendingFor(fixture, own.id)).resolves.toMatchObject({
      context: expect.stringContaining("Забрать посылку"),
    });

    // Тот же самый чат теперь принадлежит другой области: прежняя история ей не принадлежит.
    await rebindGroup(fixture, fixture.householdSpaceId);
    const neighbour = await prepareGroupTurn(fixture, fixture.householdSpaceId);
    await expect(pendingFor(fixture, neighbour.id)).resolves.toBeNull();
  });

  it("refuses a history page and a cursor from the neighbouring area", async () => {
    const first = await insertReminder(fixture, fixture.pairSpaceId);
    await recordDelivery(fixture, first, "5003");
    await recordDelivery(fixture, first, "5004");

    const page = await listFor(fixture, fixture.pairSpaceId);
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();
    await expect(listFor(fixture, fixture.householdSpaceId)).resolves.toMatchObject({ items: [] });
    // Страница, выданная в одной области, не продолжается в другой даже при том же чате.
    await expect(listFor(fixture, fixture.householdSpaceId, page.nextCursor!))
      .rejects.toThrowError(/AGENT_PROACTIVE_DELIVERY_CURSOR_INVALID/);
  });
});
