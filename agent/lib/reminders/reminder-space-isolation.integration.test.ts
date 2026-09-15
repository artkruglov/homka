/**
 * Напоминание принадлежит области, в которой заведено.
 *
 * `scope='family'` в семье с двумя общими областями не различает их вовсе: у обеих один вид
 * записей и один ключ раздела. Пока чтение шло по одному только `scope`, участник семьи получал
 * текст напоминания области, в которой не состоит, а владелец мог его ещё и удалить.
 *
 * Личный чат при этом читает **все свои** области: его аудитория — один человек. Групповой читает
 * ровно привязанную: там присутствуют другие люди.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import {
  createTwoSpaceFixture,
  currentSpacePolicyVersion,
  type TwoSpaceFixture,
} from "../spaces/two-space-fixture.js";
import type { ReminderAuthorization } from "./reminder-context.js";
import { reminderRepository } from "./reminder-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const dbDescribe = enabled ? describe : describe.skip;

const DUE_AT = new Date("2026-09-20T09:00:00.000Z");

async function enableSpaces(fixture: TwoSpaceFixture): Promise<void> {
  await database().query(
    "UPDATE family_space_runtime SET mode='spaces', cutover_at=now(), reason='Переход' WHERE family_id=$1",
    [fixture.familyId],
  );
}

async function insertFamilyReminder(fixture: TwoSpaceFixture, spaceId: string): Promise<string> {
  const inserted = await database().query<{ id: string }>(
    `INSERT INTO reminders
       (family_id, author_user_id, group_id, scope, content, timezone, telegram_chat_id,
        recurrence_anchor_local, due_at, available_at, space_id)
     VALUES ($1,$2,$3,'family','Счётчики в квартире','Europe/Moscow',$4,
             $5::timestamptz AT TIME ZONE 'Europe/Moscow',$5,$5,$6)
     RETURNING id`,
    [fixture.familyId, fixture.owner.userId, fixture.groupId, fixture.telegramChatId, DUE_AT, spaceId],
  );
  return inserted.rows[0]!.id;
}

async function privateAuth(
  fixture: TwoSpaceFixture,
  person: "owner" | "spouse",
  spaceId: string,
): Promise<ReminderAuthorization> {
  return {
    familyId: fixture.familyId,
    forumTopicId: null,
    groupId: null,
    groupType: null,
    messageThreadId: null,
    role: person === "owner" ? "owner" : "member",
    space: { policyVersion: await currentSpacePolicyVersion(spaceId), spaceId },
    telegramChatId: fixture[person].telegramUserId,
    telegramChatType: "private",
    userId: fixture[person].userId,
  };
}

async function groupAuth(fixture: TwoSpaceFixture, spaceId: string): Promise<ReminderAuthorization> {
  return {
    ...(await privateAuth(fixture, "owner", spaceId)),
    groupId: fixture.groupId,
    groupType: "family_private",
    telegramChatId: fixture.telegramChatId,
    telegramChatType: "supergroup",
  };
}

dbDescribe("reminder area isolation", () => {
  let fixture: TwoSpaceFixture;
  let householdReminderId = "";

  beforeEach(async () => {
    await database().query(
      "TRUNCATE reminders, spaces, telegram_groups, family_memberships, users, families CASCADE",
    );
    fixture = await createTwoSpaceFixture("reminder-isolation");
    await enableSpaces(fixture);
    householdReminderId = await insertFamilyReminder(fixture, fixture.householdSpaceId);
  });
  afterAll(async () => closeDatabase());

  it("hides a reminder of an area its reader does not belong to", async () => {
    // Супруга состоит только в области пары. «Хозяйство» для неё не существует.
    const spouse = await privateAuth(fixture, "spouse", fixture.pairSpaceId);
    const listed = await reminderRepository.list(spouse, { limit: 20 });
    expect(listed.items.map((item) => item.id)).not.toContain(householdReminderId);
  });

  it("refuses to change a reminder of an area its reader does not belong to", async () => {
    const spouse = await privateAuth(fixture, "spouse", fixture.pairSpaceId);
    await expect(reminderRepository.update(spouse, householdReminderId, { enabled: false, operationKey: "spouse-update" }))
      .rejects.toThrow(/AGENT_REMINDER_NOT_FOUND/u);
    await expect(reminderRepository.delete(spouse, householdReminderId, "spouse-delete"))
      .rejects.toThrow(/AGENT_REMINDER_NOT_FOUND/u);
    const stored = await database().query<{ status: string }>(
      "SELECT status::text FROM reminders WHERE id=$1", [householdReminderId],
    );
    expect(stored.rows[0]).toMatchObject({ status: "active" });
  });

  it("shows the person every area of their own in their private chat", async () => {
    // Владелец состоит в обеих областях: в личном чате он видит и ту, что не привязана к чату.
    const owner = await privateAuth(fixture, "owner", fixture.pairSpaceId);
    const listed = await reminderRepository.list(owner, { limit: 20 });
    expect(listed.items.map((item) => item.id)).toContain(householdReminderId);
  });

  it("keeps the family chat on the area it is bound to", async () => {
    // В общем чате присутствуют другие люди, поэтому «своё» там ничего не значит.
    const chat = await groupAuth(fixture, fixture.pairSpaceId);
    const listed = await reminderRepository.list(chat, { limit: 20 });
    expect(listed.items.map((item) => item.id)).not.toContain(householdReminderId);
  });
});
