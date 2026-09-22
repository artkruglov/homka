/**
 * Данные уведомлений на настоящей базе.
 *
 * Проверяется: ждущее ответа находится по всем четырём источникам; про одно и то же не пишем
 * дважды, кроме одного повтора через неделю; второе уведомление в те же сутки не уходит; человек
 * без личной сессии не адресат.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { createTwoSpaceFixture, type TwoSpaceFixture } from "../spaces/two-space-fixture.js";
import { partnerAlertRepository } from "./partner-alert-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const dbDescribe = enabled ? describe : describe.skip;

let fixture: TwoSpaceFixture;
const NOW = new Date();
const DAY = 24 * 60 * 60 * 1000;

async function privateChat(person: TwoSpaceFixture["owner"]): Promise<void> {
  await database().query(
    `INSERT INTO conversation_sessions
       (thread_id, generation, family_id, owner_user_id, group_id, scope, kind, task_state,
        conversation_key, continuation_token, started_at, last_activity_at)
     VALUES (gen_random_uuid(), 0, $1, $2, NULL, 'personal', 'canonical', NULL, $3, $3, now(), now())`,
    [fixture.familyId, person.userId, `${person.telegramUserId}::`],
  );
}

async function spouse() {
  const recipients = await partnerAlertRepository.recipients(NOW);
  return recipients.find((person) => person.userId === fixture.spouse.userId)!;
}

dbDescribe("partner alerts", () => {
  beforeEach(async () => {
    await database().query(
      `TRUNCATE partner_alert_claims, proactive_deliveries, conversation_sessions,
        application_conversations, joint_decisions, care_areas, shared_tasks, initiative_messages,
        user_notification_settings, spaces, telegram_groups, family_memberships, users, families CASCADE`,
    );
    fixture = await createTwoSpaceFixture("partner-alert");
  });
  afterAll(closeDatabase);

  it("writes only to people who wrote to the bot privately", async () => {
    await privateChat(fixture.spouse);

    expect((await partnerAlertRepository.recipients(NOW)).map((person) => person.userId))
      .toEqual([fixture.spouse.userId]);
  });

  it("finds a task, a transfer, a care area and a decision that wait for the person", async () => {
    await privateChat(fixture.spouse);
    await database().query(
      `INSERT INTO shared_tasks(family_id, scope, creator_telegram_id, assignee_telegram_id, title, status, kind)
       VALUES ($1, 'family', $2, $3, 'Забрать посылку', 'proposed', 'task')`,
      [fixture.familyId, fixture.owner.telegramUserId, fixture.spouse.telegramUserId],
    );
    await database().query(
      `INSERT INTO shared_tasks(family_id, scope, creator_telegram_id, assignee_telegram_id, title,
         status, kind, pending_assignee_telegram_id, transfer_requested_at)
       VALUES ($1, 'family', $2, $2, 'Оплатить садик', 'accepted', 'task', $3, now())`,
      [fixture.familyId, fixture.owner.telegramUserId, fixture.spouse.telegramUserId],
    );
    await database().query(
      `INSERT INTO care_areas(family_id, group_id, scope, title, creator_telegram_id,
         pending_owner_telegram_id, proposed_at, status)
       VALUES ($1, $2, 'family', 'Документы', $3, $4, now(), 'proposed')`,
      [fixture.familyId, fixture.groupId, fixture.owner.telegramUserId, fixture.spouse.telegramUserId],
    );
    await database().query(
      `INSERT INTO joint_decisions(family_id, creator_user_id, partner_user_id, title)
       VALUES ($1, $2, $3, 'Поехать к родителям')`,
      [fixture.familyId, fixture.owner.userId, fixture.spouse.userId],
    );

    const waiting = await partnerAlertRepository.pending(await spouse(), NOW);

    expect(waiting.items.map((item) => item.kind).sort()).toEqual(
      ["care_area_proposed", "decision_open", "task_proposed", "task_transfer"],
    );
    expect(waiting.items.every((item) => item.repeated)).toBe(false);
    expect(waiting.pending).toBe(0);
  });

  it("never repeats an item twice, except once after a week", async () => {
    await privateChat(fixture.spouse);
    await database().query(
      `INSERT INTO shared_tasks(family_id, scope, creator_telegram_id, assignee_telegram_id, title, status, kind)
       VALUES ($1, 'family', $2, $3, 'Забрать посылку', 'proposed', 'task')`,
      [fixture.familyId, fixture.owner.telegramUserId, fixture.spouse.telegramUserId],
    );
    const recipient = await spouse();
    const first = await partnerAlertRepository.pending(recipient, NOW);
    const ref = await partnerAlertRepository.claim(recipient, "2026-09-23", first.items, NOW);
    expect(ref).toMatch(/^[0-9a-f-]{36}$/u);

    // В тот же день и на следующий пункт молчит, через неделю напоминает один раз и умолкает.
    expect((await partnerAlertRepository.pending(recipient, NOW)).items).toEqual([]);
    const later = new Date(NOW.getTime() + 8 * DAY);
    const again = await partnerAlertRepository.pending(recipient, later);
    expect(again.items).toEqual([expect.objectContaining({ repeated: true })]);
    await partnerAlertRepository.claim(recipient, "2026-10-01", again.items, later);
    expect((await partnerAlertRepository.pending(recipient, new Date(NOW.getTime() + 30 * DAY))).items)
      .toEqual([]);
  });

  it("gives one claim a day", async () => {
    await privateChat(fixture.spouse);
    const recipient = await spouse();

    expect(await partnerAlertRepository.claim(recipient, "2026-09-23", [], NOW)).not.toBeNull();
    expect(await partnerAlertRepository.claim(recipient, "2026-09-23", [], NOW)).toBeNull();
    expect(await partnerAlertRepository.claim(recipient, "2026-09-24", [], NOW)).not.toBeNull();
  });
});
