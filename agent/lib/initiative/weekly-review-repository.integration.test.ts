/**
 * Данные недельного обзора на настоящей базе.
 *
 * Проверяется: обзор получают только те, кто сам его попросил; заявка на неделю одна, а следующая
 * неделя открывает новую; счётчик закрытого считает ровно последние семь дней.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { createTwoSpaceFixture, type TwoSpaceFixture } from "../spaces/two-space-fixture.js";
import { weeklyReviewRepository } from "./weekly-review-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const dbDescribe = enabled ? describe : describe.skip;

let fixture: TwoSpaceFixture;
// Воскресенье 27 сентября 2026, 19:00 по Москве; следующее воскресенье 4 октября.
const NOW = new Date("2026-09-27T16:00:00Z");
const NEXT_WEEK = new Date("2026-10-04T16:00:00Z");

/** Человек сам написал боту в личку: у него есть каноническая личная сессия. */
async function privateChat(person: TwoSpaceFixture["owner"]): Promise<void> {
  await database().query(
    `INSERT INTO conversation_sessions
       (thread_id, generation, family_id, owner_user_id, group_id, scope, kind, task_state,
        conversation_key, continuation_token, started_at, last_activity_at)
     VALUES (gen_random_uuid(), 0, $1, $2, NULL, 'personal', 'canonical', NULL, $3, $3, now(), now())`,
    [fixture.familyId, person.userId, `${person.telegramUserId}::`],
  );
}

async function settings(person: TwoSpaceFixture["owner"], review: boolean | null): Promise<void> {
  await database().query(
    "INSERT INTO user_notification_settings(user_id, timezone, weekly_review_enabled) VALUES ($1, 'Europe/Moscow', $2)",
    [person.userId, review],
  );
}

async function ownerRecipient() {
  const recipients = await weeklyReviewRepository.recipients(NOW);
  return recipients.find((recipient) => recipient.userId === fixture.owner.userId);
}

dbDescribe("weekly review data", () => {
  beforeEach(async () => {
    await database().query(
      `TRUNCATE proactive_deliveries, conversation_sessions, application_conversations, joint_decisions,
        personal_time_windows, shared_tasks, initiative_messages, user_notification_settings, spaces,
        telegram_groups, family_memberships, users, families CASCADE`,
    );
    fixture = await createTwoSpaceFixture("weekly-review");
  });
  afterAll(closeDatabase);

  it("writes only to people who asked for the review themselves", async () => {
    await privateChat(fixture.owner);
    await privateChat(fixture.spouse);
    // Молчание и отказ это не согласие: обзор добровольный, по умолчанию его нет ни у кого.
    await settings(fixture.owner, null);
    await settings(fixture.spouse, false);
    await expect(weeklyReviewRepository.recipients(NOW)).resolves.toEqual([]);

    await database().query(
      "UPDATE user_notification_settings SET weekly_review_enabled = true WHERE user_id = $1",
      [fixture.owner.userId],
    );
    const recipients = await weeklyReviewRepository.recipients(NOW);
    expect(recipients.map((recipient) => recipient.userId)).toEqual([fixture.owner.userId]);
    expect(recipients[0]).toMatchObject({ enabled: true, settings: { timezone: "Europe/Moscow" } });
  });

  it("claims one review a week and opens the next one seven days later", async () => {
    await privateChat(fixture.owner);
    await settings(fixture.owner, true);
    const recipient = (await ownerRecipient())!;

    const first = await weeklyReviewRepository.claim(recipient, "2026-09-27", NOW);
    expect(first).toMatch(/^[0-9a-f-]{36}$/u);
    // Следующий десятиминутный тик того же вечера второго обзора не шлёт.
    await expect(weeklyReviewRepository.claim(recipient, "2026-09-27", NOW)).resolves.toBeNull();
    await expect(weeklyReviewRepository.claim(recipient, "2026-10-04", NEXT_WEEK)).resolves.not.toBeNull();
  });

  it("counts only what was closed in the last seven days", async () => {
    await privateChat(fixture.owner);
    await settings(fixture.owner, true);
    const insert = async (title: string, status: string, ageDays: number) => {
      await database().query(
        `INSERT INTO shared_tasks(family_id, scope, creator_telegram_id, assignee_telegram_id, title,
                                  status, kind, created_at, updated_at)
         VALUES ($1, 'personal', $2, $2, $3, $4, 'task', now() - interval '60 days',
                 $5::timestamptz - make_interval(days => $6))`,
        [fixture.familyId, fixture.owner.telegramUserId, title, status, NOW, ageDays],
      );
    };
    await insert("Закрыто вчера", "completed", 1);
    await insert("Закрыто месяц назад", "completed", 30);
    await insert("Ещё открыто", "accepted", 1);

    const review = await weeklyReviewRepository.review((await ownerRecipient())!, NOW);

    expect(review.closedLastWeek).toBe(1);
    expect(review.timezone).toBe("Europe/Moscow");
    expect(review.tasks.map((task) => task.title)).toContain("Ещё открыто");
    expect(review.tasks.map((task) => task.title)).not.toContain("Закрыто вчера");
  });
});
