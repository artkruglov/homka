/**
 * Расписание принадлежит области, в которой заведено.
 *
 * В `prompt` расписания лежит сценарий, написанный для конкретной аудитории. Пока чтение шло по
 * одному `scope`, участник семьи получал сценарий области, в которой не состоит, и мог его
 * запустить или удалить.
 *
 * Автоматизация внешней группы под это правило не попадает: её заводят из лички владельца, а
 * область ей даёт привязка самого чата, которая доказывается заново перед каждой доставкой.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import {
  createTwoSpaceFixture,
  currentSpacePolicyVersion,
  type TwoSpaceFixture,
} from "../spaces/two-space-fixture.js";
import type { AgentScheduleAuthorization } from "./agent-schedule-context.js";
import { agentScheduleRepository } from "./agent-schedule-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const dbDescribe = enabled ? describe : describe.skip;

const NEXT_RUN = new Date("2026-09-20T09:00:00.000Z");

async function enableSpaces(fixture: TwoSpaceFixture): Promise<void> {
  await database().query(
    "UPDATE family_space_runtime SET mode='spaces', cutover_at=now(), reason='Переход' WHERE family_id=$1",
    [fixture.familyId],
  );
}

async function insertFamilySchedule(fixture: TwoSpaceFixture, spaceId: string): Promise<string> {
  const inserted = await database().query<{ id: string }>(
    `INSERT INTO agent_schedules
       (family_id, author_user_id, group_id, scope, title, user_request, scenario_prompt, timezone,
        telegram_chat_id, telegram_chat_type, recurrence_kind, recurrence_interval,
        recurrence_anchor_local, next_run_at, space_id)
     VALUES ($1,$2,$3,'family','Счётчики','Напоминай про показания','Напомни передать показания',
             'Europe/Moscow',$4,'supergroup','daily',1,
             $5::timestamptz AT TIME ZONE 'Europe/Moscow',$5,$6)
     RETURNING id`,
    [fixture.familyId, fixture.owner.userId, fixture.groupId, fixture.telegramChatId, NEXT_RUN, spaceId],
  );
  return inserted.rows[0]!.id;
}

async function privateAuth(
  fixture: TwoSpaceFixture,
  person: "owner" | "spouse",
  spaceId: string,
): Promise<AgentScheduleAuthorization> {
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
    telegramUserId: fixture[person].telegramUserId,
    userId: fixture[person].userId,
  };
}

dbDescribe("agent schedule area isolation", () => {
  let fixture: TwoSpaceFixture;
  let householdScheduleId = "";

  beforeEach(async () => {
    await database().query(
      "TRUNCATE agent_schedules, spaces, telegram_groups, family_memberships, users, families CASCADE",
    );
    fixture = await createTwoSpaceFixture("schedule-isolation");
    await enableSpaces(fixture);
    householdScheduleId = await insertFamilySchedule(fixture, fixture.householdSpaceId);
  });
  afterAll(async () => closeDatabase());

  it("hides the scenario of an area its reader does not belong to", async () => {
    const spouse = await privateAuth(fixture, "spouse", fixture.pairSpaceId);
    const listed = await agentScheduleRepository.list(spouse, { limit: 20 });
    expect(listed.items.map((item) => item.id)).not.toContain(householdScheduleId);
    await expect(agentScheduleRepository.findById(spouse, householdScheduleId)).resolves.toBeNull();
  });

  it("refuses to change a schedule of an area its reader does not belong to", async () => {
    const spouse = await privateAuth(fixture, "spouse", fixture.pairSpaceId);
    await expect(agentScheduleRepository.delete(spouse, householdScheduleId, "spouse-delete"))
      .rejects.toThrow(/AGENT_SCHEDULE_NOT_FOUND/u);
    const stored = await database().query("SELECT 1 FROM agent_schedules WHERE id=$1", [householdScheduleId]);
    expect(stored.rowCount).toBe(1);
  });

  it("shows the person every area of their own in their private chat", async () => {
    const owner = await privateAuth(fixture, "owner", fixture.pairSpaceId);
    const listed = await agentScheduleRepository.list(owner, { limit: 20 });
    expect(listed.items.map((item) => item.id)).toContain(householdScheduleId);
  });
});
