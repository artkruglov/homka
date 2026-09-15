/**
 * Расписание переживает ход, который его завело, поэтому область оно доказывает заново перед
 * передачей хода в Eve. Недоказанная аудитория обязана его приостановить, а не завершить:
 * `failClaim` терминален, и повторяющееся расписание после него не воскресает, а подтверждение
 * состава чата — обычный шаг Telegram, случающийся при каждом входе человека в группу.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { sessionRepository } from "../sessions/session-repository.js";
import {
  createTwoSpaceFixture,
  currentSpacePolicyVersion,
  type TwoSpaceFixture,
} from "../spaces/two-space-fixture.js";
import type { AgentScheduleAuthorization } from "./agent-schedule-context.js";
import { agentScheduleDispatchRepository } from "./agent-schedule-dispatch-repository.js";
import { agentScheduleRepository } from "./agent-schedule-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const dbDescribe = enabled ? describe : describe.skip;

const FIRST_RUN_AT = new Date("2026-09-11T09:00:00.000Z");
const NOW = new Date("2026-09-11T09:00:01.000Z");

async function familyAuth(
  fixture: TwoSpaceFixture,
  space: string | null,
): Promise<AgentScheduleAuthorization> {
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
    telegramUserId: fixture.owner.telegramUserId,
    userId: fixture.owner.userId,
  };
}

async function createFamilySchedule(fixture: TwoSpaceFixture, space: string | null, key: string) {
  return await agentScheduleRepository.create(await familyAuth(fixture, space), {
    firstRunAt: FIRST_RUN_AT,
    operationKey: key,
    recurrence: { interval: 1, kind: "daily" },
    scenarioPrompt: "Собрать утреннюю сводку.",
    scope: "family",
    timezone: "UTC",
    title: "Утренняя сводка",
    userRequest: "Каждое утро присылай сводку",
  });
}

async function claimSchedule(id: string, at = NOW) {
  const claimed = await agentScheduleDispatchRepository.claimDue({
    leaseMilliseconds: 300_000,
    limit: 25,
    now: at,
  });
  const job = claimed.find((candidate) => candidate.id === id);
  if (!job) throw new Error("AGENT_TEST_SCHEDULE_NOT_CLAIMED");
  return job;
}

async function readSchedule(id: string) {
  const row = await database().query<{
    attempts: number;
    last_error_code: string | null;
    space_id: string | null;
    status: string;
  }>("SELECT attempts, last_error_code, space_id, status FROM agent_schedules WHERE id=$1", [id]);
  return row.rows[0]!;
}

dbDescribe("agent schedule destination area", () => {
  let fixture: TwoSpaceFixture;

  beforeEach(async () => {
    await database().query(
      `TRUNCATE agent_schedules, conversation_sessions, spaces, telegram_groups,
       family_memberships, users, families CASCADE`,
    );
    fixture = await createTwoSpaceFixture("schedule-space");
    await database().query(
      "UPDATE family_space_runtime SET mode='spaces', cutover_at=now(), reason='Переход' WHERE family_id=$1",
      [fixture.familyId],
    );
  });
  afterAll(async () => closeDatabase());

  it("writes the proved area into a new schedule and refuses a turn without one", async () => {
    const created = await createFamilySchedule(fixture, fixture.pairSpaceId, "family-in-pair-space");

    await expect(readSchedule(created.id)).resolves.toMatchObject({ space_id: fixture.pairSpaceId });
    await expect(createFamilySchedule(fixture, null, "family-without-space"))
      .rejects.toThrowError(/AGENT_SPACE_CONTEXT_REQUIRED/);
  });

  it("hands the schedule's area down to the rows its dispatcher writes", async () => {
    const created = await createFamilySchedule(fixture, fixture.pairSpaceId, "family-inheritance");
    // Строки запусков заводит диспетчер, а не ход человека: область им даёт инвариант схемы.
    const run = await database().query<{ space_id: string | null }>(
      `INSERT INTO agent_schedule_runs (schedule_id, family_id, scheduled_for, status, lease_token)
       VALUES ($1, $2, now(), 'claimed', gen_random_uuid()) RETURNING space_id`,
      [created.id, fixture.familyId],
    );
    expect(run.rows[0]!.space_id).toBe(fixture.pairSpaceId);
  });

  it("suspends a run whose chat has been rebound instead of failing the schedule", async () => {
    const created = await createFamilySchedule(fixture, fixture.pairSpaceId, "family-rebound");
    await database().query(
      "UPDATE space_bindings SET state='pending_verification' WHERE group_id=$1", [fixture.groupId],
    );
    const job = await claimSchedule(created.id);

    await expect(agentScheduleDispatchRepository.markDispatchStarted(job, {
      applicationSessionId: crypto.randomUUID(),
    })).resolves.toBe(false);
    const held = await readSchedule(created.id);
    expect(held).toMatchObject({
      attempts: 0,
      last_error_code: "AGENT_SCHEDULE_DESTINATION_UNPROVEN",
      status: "active",
    });

    // Приостановка не терминальна: подтверждённый состав возвращает то же самое вхождение.
    await database().query("UPDATE space_bindings SET state='active' WHERE group_id=$1", [fixture.groupId]);
    const resumed = await claimSchedule(created.id);
    const prepared = await sessionRepository.prepareTurn({
      baseContinuationToken: `${fixture.telegramChatId}::schedule:${resumed.runId}`,
      familyId: fixture.familyId,
      groupId: fixture.groupId,
      kind: "scheduled",
      now: NOW,
      scope: "family",
      spaceContext: {
        chat: { groupId: fixture.groupId, type: "supergroup" },
        familyId: fixture.familyId,
        spaceId: fixture.pairSpaceId,
        userId: fixture.owner.userId,
      },
      telegramForumTopicId: null,
      userId: null,
    });
    await expect(agentScheduleDispatchRepository.markDispatchStarted(resumed, {
      applicationSessionId: prepared.id,
    })).resolves.toBe(true);
  });
});
