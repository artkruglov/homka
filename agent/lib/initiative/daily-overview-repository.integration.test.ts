/**
 * Содержание утреннего обзора берётся тем же путём, которым человек читает свои дела сам.
 *
 * Проверяется: просроченное отделено от сегодняшнего; чужое в обзор не попадает; заявка на сутки
 * выдаётся один раз и возвращается целиком.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import {
  createTwoSpaceFixture,
  type TwoSpaceFixture,
} from "../spaces/two-space-fixture.js";
import { dailyOverviewRepository } from "./daily-overview-repository.js";
import { formatDailyOverview } from "./daily-overview.js";
import type { DailyOverviewRecipient } from "./daily-overview-dispatch.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const dbDescribe = enabled ? describe : describe.skip;

let fixture: TwoSpaceFixture;
// The task repository uses the database clock; fixtures must follow the actual UTC day.
const NOW = new Date();
const TODAY = NOW.toISOString().slice(0, 10);

function day(shift: number): string {
  const value = new Date(`${TODAY}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + shift);
  return value.toISOString().slice(0, 10);
}

async function personalTask(owner: TwoSpaceFixture["owner"], title: string, dueOn: string) {
  await database().query(
    `INSERT INTO shared_tasks(family_id,scope,creator_telegram_id,assignee_telegram_id,title,
       status,kind,due_on,space_id)
     VALUES($1,'personal',$2,$2,$3,'accepted','task',$4::date,$5)`,
    [fixture.familyId, owner.telegramUserId, title, dueOn, fixture.pairSpaceId],
  );
}

function recipientOf(person: TwoSpaceFixture["owner"]): DailyOverviewRecipient {
  return {
    familyId: fixture.familyId,
    firstEver: false,
    settings: { dailyLimit: 3, enabled: true, quietEnd: null, quietStart: null, timezone: "UTC" },
    state: { sentToday: 0, unanswered: 0 },
    telegramUserId: person.telegramUserId,
    userId: person.userId,
  };
}

dbDescribe("daily overview data", () => {
  beforeEach(async () => {
    await database().query(
      "TRUNCATE shared_tasks, initiative_messages, spaces, telegram_groups, family_memberships, users, families CASCADE",
    );
    fixture = await createTwoSpaceFixture("daily-overview");
  });
  afterAll(closeDatabase);

  it("separates what is overdue from what is due today, and leaves other people out", async () => {
    await personalTask(fixture.owner, "Оплатить счёт", day(-2));
    await personalTask(fixture.owner, "Полить цветы", TODAY);
    await personalTask(fixture.owner, "Записаться к врачу", day(3));
    await personalTask(fixture.spouse, "Её личное дело", TODAY);

    const text = formatDailyOverview(await dailyOverviewRepository.overview(recipientOf(fixture.owner)))!;

    expect(text).toContain("⚠️ Просрочено · 1\n• Оплатить счёт");
    expect(text).toContain("Сегодня · 1\n• Полить цветы");
    expect(text).toContain("• Записаться к врачу");
    expect(text).not.toContain("Её личное дело");
  });

  it("shows tasks without a space while the family still runs the legacy mode", async () => {
    // 22 сентября 2026: обзор подставлял личное пространство, и дела без привязки к нему, то есть
    // почти все старые и новые из семейной группы, пропадали. Три просроченных дела не показывались.
    await database().query(
      `INSERT INTO shared_tasks(family_id,scope,creator_telegram_id,assignee_telegram_id,title,status,kind,due_on,list_name)
       VALUES($1,'personal',$2,$2,'Договориться с мастером','accepted','task',$3::date,'Встречи'),
             ($1,'personal',$2,$2,'Продвинуться по продаже','accepted','task',NULL,'Работа')`,
      [fixture.familyId, fixture.owner.telegramUserId, day(-7)],
    );
    await database().query(
      `INSERT INTO shared_tasks(family_id,scope,creator_telegram_id,assignee_telegram_id,title,status,kind,due_at)
       VALUES($1,'personal',$2,$2,'Встреча в Zoom','accepted','task',now() - interval '6 days')`,
      [fixture.familyId, fixture.owner.telegramUserId],
    );

    const text = formatDailyOverview(await dailyOverviewRepository.overview(recipientOf(fixture.owner)))!;

    expect(text).toContain("⚠️ Просрочено · 2");
    expect(text).toContain("• Договориться с мастером");
    expect(text).toContain("• Встреча в Zoom");
    expect(text).toContain("Работа · 1\n• Продвинуться по продаже");
  });

  it("gives the day away once and takes it back whole", async () => {
    const recipient = recipientOf(fixture.owner);
    // Заявка отдаёт ссылку доставки: под ней отправленный обзор попадает в журнал личного чата.
    await expect(dailyOverviewRepository.claim(recipient, TODAY)).resolves.toMatch(/^[0-9a-f-]{36}$/u);
    await expect(dailyOverviewRepository.claim(recipient, TODAY)).resolves.toBeNull();
    await dailyOverviewRepository.release(recipient, TODAY);
    await expect(dailyOverviewRepository.claim(recipient, TODAY)).resolves.toMatch(/^[0-9a-f-]{36}$/u);
  });

  it("reads every person with a private chat and their own rule", async () => {
    await database().query(
      `INSERT INTO user_notification_settings(user_id,timezone,quiet_start,quiet_end,initiative_enabled)
       VALUES($1,'Europe/Moscow','23:00','07:00',false)`,
      [fixture.spouse.userId],
    );
    const recipients = await dailyOverviewRepository.recipients(NOW);
    expect(recipients).toEqual(expect.arrayContaining([
      expect.objectContaining({
        settings: expect.objectContaining({ enabled: false, timezone: "Europe/Moscow" }),
        userId: fixture.spouse.userId,
      }),
      expect.objectContaining({
        firstEver: true,
        settings: expect.objectContaining({ enabled: true, timezone: "UTC" }),
        userId: fixture.owner.userId,
      }),
    ]));
  });
});
