/**
 * Данные коуча на настоящей базе.
 *
 * Проверяется: пишем только тем, кто сам писал боту в личку и не сказал «без коуча»; факты повода
 * читаются из структуры (предложение партнёра, тихая традиция, окна, традиции семьи); касание одно
 * в сутки; отправленный вопрос виден следующему ходу личного чата.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { proactiveDeliveryRepository } from "../proactive-deliveries/proactive-delivery-repository.js";
import { createTwoSpaceFixture, type TwoSpaceFixture } from "../spaces/two-space-fixture.js";
import { COACH_INVITE_TEXT } from "./coach.js";
import { coachRepository } from "./coach-repository.js";
import { recordInitiativeDelivery } from "./initiative-delivery.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const dbDescribe = enabled ? describe : describe.skip;

let fixture: TwoSpaceFixture;
const NOW = new Date();

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

async function settings(person: TwoSpaceFixture["owner"], coach: boolean | null): Promise<void> {
  await database().query(
    "INSERT INTO user_notification_settings(user_id, timezone, coach_enabled) VALUES ($1, 'UTC', $2)",
    [person.userId, coach],
  );
}

async function ownerRecipient() {
  const recipients = await coachRepository.recipients(NOW);
  return recipients.find((recipient) => recipient.userId === fixture.owner.userId);
}

dbDescribe("coach data", () => {
  beforeEach(async () => {
    await database().query(
      `TRUNCATE proactive_deliveries, conversation_sessions, application_conversations, joint_decisions,
        personal_time_windows, shared_tasks, initiative_messages, user_notification_settings, spaces,
        telegram_groups, family_memberships, users, families CASCADE`,
    );
    fixture = await createTwoSpaceFixture("coach");
  });
  afterAll(closeDatabase);

  it("writes only to people who wrote to the bot privately and have not declined the coach", async () => {
    await privateChat(fixture.owner);
    await settings(fixture.owner, null);
    await settings(fixture.spouse, null);

    expect((await coachRepository.recipients(NOW)).map((recipient) => recipient.userId))
      .toEqual([fixture.owner.userId]);

    await database().query("UPDATE user_notification_settings SET coach_enabled = false WHERE user_id = $1",
      [fixture.owner.userId]);
    await expect(coachRepository.recipients(NOW)).resolves.toEqual([]);
  });

  it("uses the family owner's timezone for a person who has no settings of their own", async () => {
    // Без этого окно 10-21 считалось в UTC и первый вопрос мог прийти ночью.
    await privateChat(fixture.owner);
    await privateChat(fixture.spouse);
    await settings(fixture.owner, true);

    const recipients = await coachRepository.recipients(NOW);

    expect(recipients.find((person) => person.userId === fixture.spouse.userId)?.settings.timezone)
      .toBe("UTC");
    await database().query("UPDATE user_notification_settings SET timezone = 'Asia/Tokyo' WHERE user_id = $1",
      [fixture.owner.userId]);
    const withOwnerZone = await coachRepository.recipients(NOW);
    expect(withOwnerZone.find((person) => person.userId === fixture.spouse.userId)?.settings.timezone)
      .toBe("Asia/Tokyo");
  });

  it("reads the reasons from structure: a partner's proposal, a quiet tradition, windows and traditions", async () => {
    await privateChat(fixture.owner);
    await settings(fixture.owner, true);
    const empty = (await ownerRecipient())!.facts;
    expect(empty).toMatchObject({ enabled: true, familyRituals: 0, invited: false, openDecision: null,
      personalWindows: 0, quietRitual: null });

    const decision = await database().query<{ id: string }>(
      `INSERT INTO joint_decisions(family_id, creator_user_id, partner_user_id, title)
       VALUES ($1, $2, $3, 'Чай без телефонов по воскресеньям') RETURNING id`,
      [fixture.familyId, fixture.spouse.userId, fixture.owner.userId],
    );
    const ritual = await database().query<{ id: string }>(
      `INSERT INTO shared_tasks(family_id, scope, creator_telegram_id, assignee_telegram_id, title, status, kind, created_at)
       VALUES ($1, 'family', $2, $2, 'Воскресный чай', 'accepted', 'ritual', now() - interval '30 days') RETURNING id`,
      [fixture.familyId, fixture.owner.telegramUserId],
    );
    await database().query(
      `INSERT INTO personal_time_windows(family_id, user_id, title, weekday, starts_at, ends_at)
       VALUES ($1, $2, 'Бег', 6, '08:00', '09:00')`,
      [fixture.familyId, fixture.owner.userId],
    );

    const facts = (await ownerRecipient())!.facts;
    expect(facts.openDecision).toEqual({ id: decision.rows[0]!.id, proposer: expect.any(String),
      title: "Чай без телефонов по воскресеньям" });
    expect(facts.quietRitual).toEqual({ id: ritual.rows[0]!.id, title: "Воскресный чай" });
    expect(facts).toMatchObject({ familyRituals: 1, personalWindows: 1 });

    // Отмеченная традиция и уже заданный вопрос о предложении больше не повод.
    await database().query(
      "INSERT INTO shared_ritual_occurrences(task_id, actor_telegram_id, occurred_on, note) VALUES ($1, $2, CURRENT_DATE - 1, 'Было тепло')",
      [ritual.rows[0]!.id, fixture.owner.telegramUserId],
    );
    const recipient = (await ownerRecipient())!;
    await coachRepository.claim(recipient, "2026-09-01",
      { reason: "decision_open", subject: decision.rows[0]!.id, text: "…" }, new Date(NOW.getTime() - 3 * 86_400_000));
    const after = (await ownerRecipient())!.facts;
    expect(after.quietRitual).toBeNull();
    expect(after.openDecision).toBeNull();
    expect(after.lastByReason.decision_open).toBeInstanceOf(Date);
    expect(after.touchesLastWeek).toBe(1);
  });

  it("claims one touch a day and the sent question reaches the next private turn", async () => {
    await privateChat(fixture.owner);
    await settings(fixture.owner, null);
    const recipient = (await ownerRecipient())!;
    const touch = { reason: "invite" as const, subject: null, text: COACH_INVITE_TEXT };

    const ref = await coachRepository.claim(recipient, "2026-09-23", touch, NOW);
    expect(ref).toMatch(/^[0-9a-f-]{36}$/u);
    // Заявка на сутки одна и назад не отдаётся: определённый отказ Telegram ждёт следующего дня.
    await expect(coachRepository.claim(recipient, "2026-09-23", touch, NOW)).resolves.toBeNull();
    const again = await coachRepository.claim(recipient, "2026-09-24", touch, NOW);
    expect(again).not.toBeNull();
    expect((await ownerRecipient())!.facts.invited).toBe(true);

    const session = await database().query<{ id: string }>(
      `INSERT INTO conversation_sessions
         (thread_id, generation, family_id, owner_user_id, group_id, scope, kind, task_state,
          conversation_key, continuation_token, started_at, last_activity_at)
       VALUES (gen_random_uuid(), 0, $1, $2, NULL, 'personal', 'proactive', 'running', 'coach::', 'coach::', now(), now())
       RETURNING id`,
      [fixture.familyId, fixture.owner.userId],
    );
    await recordInitiativeDelivery({
      at: NOW, deliveryRef: again!, familyId: fixture.familyId, messageId: "901", sourceKind: "coach",
      telegramUserId: fixture.owner.telegramUserId, text: COACH_INVITE_TEXT, userId: fixture.owner.userId,
    });

    const pending = await proactiveDeliveryRepository.listPendingContext({
      applicationSessionId: session.rows[0]!.id, familyId: fixture.familyId, groupId: null,
      messageThreadId: null, now: new Date(NOW.getTime() + 60_000), ownerUserId: fixture.owner.userId,
      scope: "personal", telegramChatId: fixture.owner.telegramUserId,
    });
    expect(pending?.context).toContain('"sourceKind":"coach"');
    expect(pending?.context).toContain("Без коуча");
  });
});
