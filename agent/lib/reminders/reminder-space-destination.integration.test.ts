/**
 * Адресат проактивной доставки доказывается непосредственно перед отправкой.
 *
 * `space_bindings.group_id` — первичный ключ, поэтому перепривязка чата к другой области меняет
 * аудиторию у того же самого `telegram_chat_id`. Напоминание, заведённое прежней аудиторией,
 * после этого обязано ждать, а не уходить новым читателям; и обязано именно ждать, а не
 * завершаться терминально: подтверждение состава — обычный шаг, а не авария.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { currentSpacePolicyVersion, createTwoSpaceFixture, type TwoSpaceFixture } from "../spaces/two-space-fixture.js";
import type { ReminderAuthorization } from "./reminder-context.js";
import { reminderDispatchRepository } from "./reminder-dispatch-repository.js";
import { reminderRepository } from "./reminder-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const dbDescribe = enabled ? describe : describe.skip;

const DUE_AT = new Date("2026-09-11T09:00:00.000Z");
const NOW = new Date("2026-09-11T09:01:00.000Z");

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
     VALUES ($1,$2,$3,'family','Забрать посылку','Europe/Moscow',$4,
             $5::timestamptz AT TIME ZONE 'Europe/Moscow',$5,$5,$6)
     RETURNING id`,
    [fixture.familyId, fixture.owner.userId, fixture.groupId, fixture.telegramChatId, DUE_AT, spaceId],
  );
  return inserted.rows[0]!.id;
}

async function claimReminder(id: string, at = NOW) {
  const claimed = await reminderDispatchRepository.claimDue({
    leaseMilliseconds: 60_000,
    limit: 25,
    now: at,
  });
  const job = claimed.find((candidate) => candidate.id === id);
  if (!job) throw new Error("AGENT_TEST_REMINDER_NOT_CLAIMED");
  return job;
}

async function readReminder(id: string) {
  const row = await database().query<{
    attempts: number;
    available_at: Date;
    last_error_code: string | null;
    status: string;
  }>("SELECT attempts, available_at, last_error_code, status FROM reminders WHERE id=$1", [id]);
  return row.rows[0]!;
}

async function pauseBinding(fixture: TwoSpaceFixture): Promise<void> {
  await database().query(
    "UPDATE space_bindings SET state='pending_verification' WHERE group_id=$1",
    [fixture.groupId],
  );
}

async function familyAuth(
  fixture: TwoSpaceFixture,
  space: string | null,
): Promise<ReminderAuthorization> {
  return {
    familyId: fixture.familyId,
    forumTopicId: null,
    groupId: fixture.groupId,
    groupType: "family_private",
    messageThreadId: null,
    role: "owner",
    ...(space === null
      ? {}
      : { space: { policyVersion: await currentSpacePolicyVersion(space), spaceId: space } }),
    telegramChatId: fixture.telegramChatId,
    telegramChatType: "supergroup",
    userId: fixture.owner.userId,
  };
}

dbDescribe("reminder destination area", () => {
  let fixture: TwoSpaceFixture;

  beforeEach(async () => {
    await database().query(
      `TRUNCATE reminders, spaces, telegram_groups, family_memberships, users, families CASCADE`,
    );
    fixture = await createTwoSpaceFixture("reminder-space");
    await enableSpaces(fixture);
  });
  afterAll(async () => closeDatabase());

  it("writes the proved area into a new reminder and refuses a turn without one", async () => {
    const auth = await familyAuth(fixture, fixture.pairSpaceId);
    await reminderRepository.configureNotifications(auth, {
      quietEnd: null, quietStart: null, timezone: "Europe/Moscow",
    });
    const created = await reminderRepository.create(auth, {
      content: "Забрать посылку",
      firstRunAt: new Date(Date.now() + 3_600_000),
      operationKey: "family-in-pair-space",
      recurrence: null,
      scope: "family",
      timezone: "Europe/Moscow",
    });
    const stored = await database().query<{ space_id: string | null }>(
      "SELECT space_id FROM reminders WHERE id=$1", [created.id],
    );
    expect(stored.rows[0]!.space_id).toBe(fixture.pairSpaceId);

    // Забытый путь после включения обязан упасть громко, а не завести строку без области.
    await expect(reminderRepository.create(await familyAuth(fixture, null), {
      content: "Забрать вторую посылку",
      firstRunAt: new Date(Date.now() + 3_600_000),
      operationKey: "family-without-space",
      recurrence: null,
      scope: "family",
      timezone: "Europe/Moscow",
    })).rejects.toThrowError(/AGENT_SPACE_CONTEXT_REQUIRED/);
  });

  it("sends a reminder whose area is still the one bound to the destination chat", async () => {
    const id = await insertFamilyReminder(fixture, fixture.pairSpaceId);
    const job = await claimReminder(id);

    await expect(reminderDispatchRepository.markDispatchStarted(id, job.leaseToken)).resolves
      .toBeUndefined();
    await expect(readReminder(id)).resolves.toMatchObject({ status: "leased" });
  });

  it("holds a reminder whose chat has been rebound to another area", async () => {
    const id = await insertFamilyReminder(fixture, fixture.pairSpaceId);
    // Тот же самый чат теперь принадлежит другой области: аудитория сменилась, адрес нет.
    await pauseBinding(fixture);
    await database().query(
      "UPDATE space_bindings SET space_id=$2 WHERE group_id=$1",
      [fixture.groupId, fixture.householdSpaceId],
    );
    await database().query("UPDATE space_bindings SET state='active' WHERE group_id=$1", [fixture.groupId]);
    const job = await claimReminder(id);

    await expect(reminderDispatchRepository.markDispatchStarted(id, job.leaseToken)).rejects
      .toThrowError(/AGENT_REMINDER_DESTINATION_UNPROVEN/);
    const held = await readReminder(id);
    // Ждёт, а не завершено: состав подтверждают и напоминание уходит с опозданием.
    expect(held).toMatchObject({ attempts: 0, last_error_code: "AGENT_REMINDER_DESTINATION_UNPROVEN", status: "active" });
    expect(held.available_at.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it("holds a reminder while the audience of its chat is not confirmed and sends it afterwards", async () => {
    const id = await insertFamilyReminder(fixture, fixture.pairSpaceId);
    await pauseBinding(fixture);
    const held = await claimReminder(id);
    await expect(reminderDispatchRepository.markDispatchStarted(id, held.leaseToken)).rejects
      .toThrowError(/AGENT_REMINDER_DESTINATION_UNPROVEN/);

    await database().query("UPDATE space_bindings SET state='active' WHERE group_id=$1", [fixture.groupId]);
    // Задержка ожидания отсчитывается часами базы, а не синтетическими часами теста.
    const resumed = await claimReminder(id, new Date(Date.now() + 5 * 60_000));
    await expect(reminderDispatchRepository.markDispatchStarted(id, resumed.leaseToken)).resolves
      .toBeUndefined();
  });
});
