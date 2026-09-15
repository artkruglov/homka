/**
 * Личное время в базе: своё окно ведёт сам человек, а чужое дело на него не встаёт.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import type { MemoryAuthorization } from "../memory-context.js";
import { personalTimeRepository } from "./personal-time-repository.js";
import { sharedTaskRepository } from "../shared-task-repository.js";
import { createTwoSpaceFixture, type TwoSpaceFixture } from "../spaces/two-space-fixture.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const dbDescribe = enabled ? describe : describe.skip;

let fixture: TwoSpaceFixture;

function auth(person: TwoSpaceFixture["owner"], group = false): MemoryAuthorization {
  return {
    familyId: fixture.familyId,
    groupId: group ? fixture.groupId : null,
    role: "member",
    scopes: group ? ["family"] : ["personal", "family"],
    telegramActorId: person.telegramUserId,
    telegramActorKind: "telegram_user",
    telegramUserId: person.telegramUserId,
    userId: person.userId,
  };
}

dbDescribe("personal time", () => {
  beforeEach(async () => {
    await database().query(
      "TRUNCATE personal_time_windows, shared_tasks, spaces, telegram_groups, family_memberships, users, families CASCADE",
    );
    fixture = await createTwoSpaceFixture("personal-time");
    await database().query(
      `INSERT INTO user_notification_settings(user_id,timezone,quiet_start,quiet_end)
       VALUES($1,'Europe/Moscow',NULL,NULL),($2,'Europe/Moscow',NULL,NULL)`,
      [fixture.owner.userId, fixture.spouse.userId],
    );
  });
  afterAll(closeDatabase);

  it("keeps a window to its own person and refuses the shared chat", async () => {
    const window = await personalTimeRepository.add(auth(fixture.spouse),
      { endsAt: "21:00", startsAt: "19:00", title: "Зал", weekday: 2 });
    expect(await personalTimeRepository.list(auth(fixture.spouse)))
      .toEqual([expect.objectContaining({ title: "Зал", weekday: 2 })]);
    expect(await personalTimeRepository.list(auth(fixture.owner))).toEqual([]);
    await expect(personalTimeRepository.list(auth(fixture.spouse, true)))
      .rejects.toThrow(/AGENT_PERSONAL_TIME_PRIVATE_ONLY/u);
    expect(await personalTimeRepository.remove(auth(fixture.owner), window.id)).toBe(false);
    expect(await personalTimeRepository.remove(auth(fixture.spouse), window.id)).toBe(true);
  });

  it("does not let another person put a task on that time", async () => {
    await personalTimeRepository.add(auth(fixture.spouse),
      { endsAt: "21:00", startsAt: "19:00", title: "Зал", weekday: 2 });
    const participants = (await sharedTaskRepository.execute(
      auth(fixture.owner, true), { action: "participants" }, "read")).participants!;
    const spouseRef = participants.find((person) => person.name === "Супруга")!.participantRef;
    // Вторник 19:30 по Москве.
    const inside = "2026-09-15T16:30:00.000Z";
    await expect(sharedTaskRepository.execute(auth(fixture.owner, true),
      { action: "create", assigneeRef: spouseRef, dueAt: inside, title: "Забрать посылку" },
      randomUUID())).rejects.toThrow(/AGENT_TASK_PERSONAL_TIME/u);

    // Своё дело на своё время человек ставит сам: окно защищает от чужих планов, не от его.
    await expect(sharedTaskRepository.execute(auth(fixture.spouse),
      { action: "create", dueAt: inside, title: "Собрать сумку" }, randomUUID()))
      .resolves.toMatchObject({ task: expect.objectContaining({ title: "Собрать сумку" }) });
    // Час спустя окно уже кончилось.
    await expect(sharedTaskRepository.execute(auth(fixture.owner, true),
      { action: "create", assigneeRef: spouseRef, dueAt: "2026-09-15T18:30:00.000Z",
        title: "Забрать посылку" }, randomUUID()))
      .resolves.toMatchObject({ task: expect.objectContaining({ status: "proposed" }) });
  });
});
