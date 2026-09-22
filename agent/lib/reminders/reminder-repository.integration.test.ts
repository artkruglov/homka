/**
 * PostgreSQL reminder lifecycle integration tests.
 *
 * Constructs covered:
 * - Scoped settings and author-or-owner reminder mutations.
 * - Quiet-hour deferral, durable leases, recurrence, and ambiguous-delivery recovery.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { closeDatabase, database } from "../database.js";
import { reminderDispatchRepository } from "./reminder-dispatch-repository.js";
import { reminderRepository } from "./reminder-repository.js";

import { dispatchDueReminders } from "./reminder-dispatcher.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const describeWithDatabase = enabled ? describe : describe.skip;

interface Fixture {
  familyId: string;
  groupId: string;
  memberId: string;
  ownerId: string;
}

async function createFixture(): Promise<Fixture> {
  const family = await database().query<{ id: string }>(
    "INSERT INTO families (name) VALUES ('Напоминания') RETURNING id",
  );
  const users = await database().query<{ id: string; telegram_user_id: string }>(
    `INSERT INTO users (telegram_user_id, display_name)
     VALUES ('reminder-owner', 'Владелец'), ('reminder-member', 'Участник')
     RETURNING id, telegram_user_id`,
  );
  const ownerId = users.rows.find((row) => row.telegram_user_id === "reminder-owner")!.id;
  const memberId = users.rows.find((row) => row.telegram_user_id === "reminder-member")!.id;
  await database().query(
    `INSERT INTO family_memberships (family_id, user_id, role)
     VALUES ($1, $2, 'owner'), ($1, $3, 'member')`,
    [family.rows[0]!.id, ownerId, memberId],
  );
  const group = await database().query<{ id: string }>(
    `INSERT INTO telegram_groups
       (family_id, telegram_chat_id, title, type, message_mode)
     VALUES ($1, '-100-reminders', 'Семья', 'family_private', 'addressed_only')
     RETURNING id`,
    [family.rows[0]!.id],
  );
  return { familyId: family.rows[0]!.id, groupId: group.rows[0]!.id, memberId, ownerId };
}

function privateAuth(fixture: Fixture, user: "member" | "owner") {
  const owner = user === "owner";
  return {
    familyId: fixture.familyId,
    forumTopicId: null,
    groupId: null,
    groupType: null,
    messageThreadId: null,
    role: owner ? "owner" as const : "member" as const,
    telegramChatId: owner ? "reminder-owner" : "reminder-member",
    telegramChatType: "private" as const,
    userId: owner ? fixture.ownerId : fixture.memberId,
  };
}

function familyAuth(fixture: Fixture, user: "member" | "owner") {
  const base = privateAuth(fixture, user);
  return {
    ...base,
    groupId: fixture.groupId,
    forumTopicId: "77",
    groupType: "family_private" as const,
    messageThreadId: "77",
    telegramChatId: "-100-reminders",
    telegramChatType: "supergroup" as const,
  };
}

describeWithDatabase("reminder repositories", () => {
  beforeEach(async () => {
    await database().query(
      "TRUNCATE reminders, user_notification_settings, telegram_groups, family_memberships, users, families CASCADE",
    );
  });
  afterAll(async () => closeDatabase());
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("turns the coach on for a person who has no settings row yet", async () => {
    // Приглашение коуча уходит как раз тем, у кого настроек ещё нет: 22 сентября 2026 участница
    // семьи не смогла ответить ни «да», ни «без коуча» — оба ответа падали на отсутствующей строке.
    const fixture = await createFixture();
    await reminderRepository.configureNotifications(privateAuth(fixture, "owner"), {
      quietEnd: null, quietStart: null, timezone: "Europe/Moscow",
    });

    await expect(reminderRepository.setCoach(privateAuth(fixture, "member"), true))
      .resolves.toMatchObject({ coachEnabled: true, timezone: "Europe/Moscow" });

    // Выключение работает и вовсе без известного пояса: молчание важнее точного времени.
    await database().query("DELETE FROM user_notification_settings");
    await expect(reminderRepository.setCoach(privateAuth(fixture, "member"), false))
      .resolves.toMatchObject({ coachEnabled: false, timezone: "UTC" });
  });

  it("delivers and durably completes a saved reminder while every non-Telegram HTTP endpoint fails", async () => {
    const fixture = await createFixture();
    const auth = privateAuth(fixture, "member");
    await reminderRepository.configureNotifications(auth, {
      quietEnd: null, quietStart: null, timezone: "Europe/Moscow",
    });
    const now = new Date();
    const reminder = await reminderRepository.create(auth, {
      content: "Достать молоко из холодильника",
      firstRunAt: now, operationKey: "llm-outage-delivery", recurrence: null,
      scope: "personal", timezone: "Europe/Moscow",
    });
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "reminder-test-only");
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname !== "api.telegram.org") {
        return new Response("model provider unavailable", { status: 503 });
      }
      expect(url.pathname).toBe("/botreminder-test-only/sendMessage");
      // Observe the real durable marker at the network boundary, before acknowledging Telegram.
      const pending = await database().query(
        "SELECT status, dispatch_started_at FROM reminders WHERE id=$1", [reminder.id],
      );
      expect(pending.rows[0].status).toBe("leased");
      expect(pending.rows[0].dispatch_started_at).not.toBeNull();
      expect(JSON.parse(String(init?.body))).toEqual({
        chat_id: auth.telegramChatId,
        text: "Напоминание:\n\nДостать молоко из холодильника",
      });
      return new Response(JSON.stringify({ ok: true,
        result: { message_id: 710, chat: { id: 902, type: "private" } },
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(dispatchDueReminders(now)).resolves.toBe(1);
    await expect(dispatchDueReminders(new Date(now.getTime() + 60_000))).resolves.toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const state = await database().query(
      "SELECT status, attempts FROM reminders WHERE id=$1", [reminder.id],
    );
    expect(state.rows).toEqual([{ status: "completed", attempts: 1 }]);
    const receipts = await database().query(
      "SELECT telegram_message_id, content_text FROM proactive_deliveries WHERE source_id=$1", [reminder.id],
    );
    expect(receipts.rows).toEqual([{
      telegram_message_id: "710", content_text: "Напоминание:\n\nДостать молоко из холодильника",
    }]);
  });


  it("requires explicit valid notification settings before creating a personal reminder", async () => {
    const fixture = await createFixture();
    const auth = privateAuth(fixture, "member");

    await expect(reminderRepository.create(auth, {
      content: "Позвонить врачу",
      firstRunAt: new Date("2026-07-13T06:00:00.000Z"),
      operationKey: "personal-without-settings",
      recurrence: null,
      scope: "personal",
      timezone: "Europe/Moscow",
    })).rejects.toThrowError(/AGENT_NOTIFICATION_SETTINGS_REQUIRED/);
    await expect(reminderRepository.configureNotifications(auth, {
      quietEnd: "07:00",
      quietStart: "23:00",
      timezone: "Not\/A-Timezone",
    })).rejects.toThrowError(/AGENT_TIMEZONE_INVALID/);

    await expect(reminderRepository.configureNotifications(auth, {
      quietEnd: "07:00",
      quietStart: "23:00",
      timezone: "Europe/Moscow",
    })).resolves.toMatchObject({ initiativeDailyLimit: 3, initiativeEnabled: true });
    // «Не пиши мне первым» переживает следующую настройку часов: непереданное поле остаётся.
    await expect(reminderRepository.configureNotifications(auth, {
      initiativeEnabled: false,
      quietEnd: "07:00",
      quietStart: "23:00",
      timezone: "Europe/Moscow",
    })).resolves.toMatchObject({ initiativeEnabled: false });
    await expect(reminderRepository.configureNotifications(auth, {
      quietEnd: "08:00",
      quietStart: "22:00",
      timezone: "Europe/Moscow",
    })).resolves.toMatchObject({ initiativeEnabled: false, quietStart: "22:00" });
    await reminderRepository.configureNotifications(auth, {
      initiativeEnabled: true,
      quietEnd: "07:00",
      quietStart: "23:00",
      timezone: "Europe/Moscow",
    });
    const reminder = await reminderRepository.create(auth, {
      content: "Позвонить врачу",
      firstRunAt: new Date("2026-07-13T06:00:00.000Z"),
      operationKey: "personal-created",
      recurrence: null,
      scope: "personal",
      timezone: "Europe/Moscow",
    });

    expect(reminder).toMatchObject({ content: "Позвонить врачу", scope: "personal", status: "active" });
    await expect(reminderRepository.list(auth, { limit: 100 })).resolves.toEqual({
      items: [reminder],
      nextCursor: null,
    });
  });

  it("keeps a personal reminder out of the family group's list and mutations", async () => {
    const fixture = await createFixture();
    const auth = privateAuth(fixture, "member");
    await reminderRepository.configureNotifications(auth, { quietEnd: "07:00", quietStart: "23:00", timezone: "Europe/Moscow" });
    const personal = await reminderRepository.create(auth, {
      content: "Купить подарок жене втайне",
      firstRunAt: new Date("2026-07-13T06:00:00.000Z"),
      operationKey: "personal-secret",
      recurrence: null,
      scope: "personal",
      timezone: "Europe/Moscow",
    });
    const family = await reminderRepository.create(familyAuth(fixture, "member"), {
      content: "Вынести мусор",
      firstRunAt: new Date("2026-07-13T07:00:00.000Z"),
      operationKey: "family-chore",
      recurrence: null,
      scope: "family",
      timezone: "Europe/Moscow",
    });

    // The same member asked from the family group: private text must not enter the shared context.
    await expect(reminderRepository.list(familyAuth(fixture, "member"), { limit: 100 }))
      .resolves.toEqual({ items: [family], nextCursor: null });
    await expect(reminderRepository.update(familyAuth(fixture, "member"), personal.id, {
      content: "изменено из группы", operationKey: "personal-from-group",
    })).rejects.toThrowError(/AGENT_REMINDER_NOT_FOUND/);
    await expect(reminderRepository.delete(familyAuth(fixture, "member"), personal.id, "delete-from-group"))
      .rejects.toThrowError(/AGENT_REMINDER_NOT_FOUND/);
    // The private chat still sees both areas.
    await expect(reminderRepository.list(auth, { limit: 100 }))
      .resolves.toMatchObject({ items: [family, personal] });
  });

  it("allows a family reminder to be changed only by its author or current owner", async () => {
    const fixture = await createFixture();
    const member = familyAuth(fixture, "member");
    const owner = familyAuth(fixture, "owner");
    await reminderRepository.configureNotifications(privateAuth(fixture, "member"), {
      quietEnd: null,
      quietStart: null,
      timezone: "Europe/Moscow",
    });
    const reminder = await reminderRepository.create(member, {
      content: "Собрать документы",
      firstRunAt: new Date("2026-07-13T06:00:00.000Z"),
      operationKey: "family-created",
      recurrence: { interval: 1, unit: "weekly" },
      scope: "family",
      timezone: "Europe/Moscow",
    });

    await expect(reminderRepository.update(owner, reminder.id, {
      content: "Собрать семейные документы",
      enabled: true,
      operationKey: "family-owner-update",
    })).resolves.toMatchObject({ content: "Собрать семейные документы" });
    await expect(reminderRepository.delete(member, reminder.id, "family-author-delete")).resolves.toBe(true);
  });

  it("replays an approved recurrence removal without a second mutation", async () => {
    const fixture = await createFixture();
    const auth = privateAuth(fixture, "member");
    await reminderRepository.configureNotifications(auth, {
      quietEnd: null,
      quietStart: null,
      timezone: "Europe/Moscow",
    });
    const reminder = await reminderRepository.create(auth, {
      content: "Позвонить врачу",
      firstRunAt: new Date("2026-08-18T07:00:00.000Z"),
      operationKey: "recurrence-created",
      recurrence: { interval: 1, unit: "daily" },
      scope: "personal",
      timezone: "Europe/Moscow",
    });
    const update = { operationKey: "recurrence-removed", recurrence: null } as const;

    const first = await reminderRepository.update(auth, reminder.id, update);
    const replay = await reminderRepository.update(auth, reminder.id, update);

    expect(first.recurrence).toBeNull();
    expect(replay).toEqual(first);
    const audits = await database().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_events
        WHERE event_type = 'reminder.updated' AND subject_id = $1`,
      [reminder.id],
    );
    expect(audits.rows[0]?.count).toBe("1");
  });

  it("defers a due reminder through quiet hours and completes a one-time delivery", async () => {
    const fixture = await createFixture();
    const auth = privateAuth(fixture, "member");
    await reminderRepository.configureNotifications(auth, {
      quietEnd: "07:00",
      quietStart: "23:00",
      timezone: "Europe/Moscow",
    });
    const reminder = await reminderRepository.create(auth, {
      content: "Проверить дверь",
      firstRunAt: new Date("2026-07-12T20:30:00.000Z"),
      operationKey: "quiet-created",
      recurrence: null,
      scope: "personal",
      timezone: "Europe/Moscow",
    });

    await expect(reminderDispatchRepository.claimDue({
      leaseMilliseconds: 300_000,
      limit: 10,
      now: new Date("2026-07-12T20:31:00.000Z"),
    })).resolves.toEqual([]);
    const [claimed] = await reminderDispatchRepository.claimDue({
      leaseMilliseconds: 300_000,
      limit: 10,
      now: new Date("2026-07-13T04:00:00.000Z"),
    });
    expect(claimed).toMatchObject({ delayed: true, id: reminder.id, telegramChatId: "reminder-member" });

    await reminderDispatchRepository.markDispatchStarted(claimed!.id, claimed!.leaseToken);
    await reminderDispatchRepository.complete(
      claimed!,
      new Date("2026-07-13T04:00:01.000Z"),
      { messageId: "601", text: "Напоминание:\n\nПроверить дверь" },
    );
    await expect(reminderRepository.list(auth, { limit: 100 })).resolves.toMatchObject({
      items: [expect.objectContaining({ id: reminder.id, status: "completed" })],
      nextCursor: null,
    });
  });

  it("advances recurring wall-clock time across DST and skips missed occurrences", async () => {
    const fixture = await createFixture();
    const auth = privateAuth(fixture, "member");
    await reminderRepository.configureNotifications(auth, {
      quietEnd: null,
      quietStart: null,
      timezone: "Europe/Berlin",
    });
    const reminder = await reminderRepository.create(auth, {
      content: "Утреннее лекарство",
      firstRunAt: new Date("2026-03-28T08:00:00.000Z"),
      operationKey: "dst-created",
      recurrence: { interval: 1, unit: "daily" },
      scope: "personal",
      timezone: "Europe/Berlin",
    });
    const [claimed] = await reminderDispatchRepository.claimDue({
      leaseMilliseconds: 300_000,
      limit: 1,
      now: new Date("2026-03-28T08:00:00.000Z"),
    });
    await reminderDispatchRepository.markDispatchStarted(claimed!.id, claimed!.leaseToken);
    const receipt = { messageId: "602", text: "Напоминание:\n\nУтреннее лекарство" };
    await reminderDispatchRepository.complete(claimed!, new Date("2026-03-28T08:01:00.000Z"), receipt);
    // A bookkeeping retry after a lost COMMIT acknowledgement finds the delivery already recorded:
    // success, not a stale lease that would fail a recurring reminder for good (upstream 2167e2c).
    await expect(reminderDispatchRepository.complete(claimed!, new Date("2026-03-28T08:01:05.000Z"), receipt))
      .resolves.toBeUndefined();
    await expect(reminderDispatchRepository.complete(claimed!, new Date("2026-03-28T08:01:05.000Z"), {
      ...receipt, messageId: "603",
    })).rejects.toMatchObject({ code: "AGENT_REMINDER_LEASE_STALE" });

    const { items: [stored] } = await reminderRepository.list(auth, { limit: 100 });
    expect(stored).toMatchObject({ id: reminder.id, nextRunAt: "2026-03-29T07:00:00.000Z", status: "active" });
  });

  it("does not retry an expired lease after Telegram dispatch may have started", async () => {
    const fixture = await createFixture();
    const auth = privateAuth(fixture, "member");
    await reminderRepository.configureNotifications(auth, {
      quietEnd: null,
      quietStart: null,
      timezone: "UTC",
    });
    await reminderRepository.create(auth, {
      content: "Не продублировать",
      firstRunAt: new Date("2026-07-12T10:00:00.000Z"),
      operationKey: "ambiguous-created",
      recurrence: null,
      scope: "personal",
      timezone: "UTC",
    });
    const [claimed] = await reminderDispatchRepository.claimDue({
      leaseMilliseconds: 1_000,
      limit: 1,
      now: new Date("2026-07-12T10:00:00.000Z"),
    });
    await reminderDispatchRepository.markDispatchStarted(claimed!.id, claimed!.leaseToken);

    await expect(reminderDispatchRepository.claimDue({
      leaseMilliseconds: 1_000,
      limit: 1,
      now: new Date("2026-07-12T10:00:02.000Z"),
    })).resolves.toEqual([]);
    await expect(reminderRepository.list(auth, { limit: 100 })).resolves.toMatchObject({
      items: [
        expect.objectContaining({ lastErrorCode: "AGENT_REMINDER_DELIVERY_AMBIGUOUS", status: "failed" }),
      ],
      nextCursor: null,
    });
  });

  it("paginates more than 100 active reminders without duplicates or skipped timestamp ties", async () => {
    const fixture = await createFixture();
    const auth = privateAuth(fixture, "member");
    const inserted = await database().query<{ id: string }>(
      `INSERT INTO reminders
         (family_id, owner_user_id, author_user_id, scope, content, timezone, telegram_chat_id,
          recurrence_anchor_local, due_at, available_at, created_at)
       SELECT $1, $2, $2, 'personal', 'Напоминание ' || item, 'UTC', 'reminder-member',
              timestamp '2026-01-01 00:00:00', timestamptz '2026-01-01 00:00:00+00',
              timestamptz '2026-01-01 00:00:00+00',
              timestamptz '2026-02-01 00:00:00+00'
         FROM generate_series(1, 102) AS item
       RETURNING id`,
      [fixture.familyId, fixture.memberId],
    );

    const first = await reminderRepository.list(auth, { limit: 100 });
    const second = await reminderRepository.list(auth, { cursor: first.nextCursor!, limit: 100 });
    const ids = [...first.items, ...second.items].map((item) => item.id);

    expect(first.nextCursor).not.toBeNull();
    expect(second.nextCursor).toBeNull();
    expect(ids).toHaveLength(102);
    expect(new Set(ids)).toHaveLength(102);
    expect(new Set(ids)).toEqual(new Set(inserted.rows.map((row) => row.id)));
    await expect(reminderRepository.list(auth, { cursor: "invalid", limit: 100 }))
      .rejects.toMatchObject({ code: "AGENT_REMINDER_CURSOR_INVALID" });
  });
  it("removes automatic migration resume eligibility when the author explicitly pauses",async()=>{
    const f=await createFixture();const auth=familyAuth(f,'owner');
    await reminderRepository.configureNotifications(privateAuth(f,'owner'),{timezone:'UTC',quietStart:null,quietEnd:null});
    const reminder=await reminderRepository.create(auth,{content:'Delivery',scope:'family',timezone:'UTC',
      firstRunAt:new Date('2026-10-01T12:00:00Z'),recurrence:null,operationKey:'migration-create'});
    await database().query("UPDATE reminders SET status='paused',last_error_code='AGENT_TELEGRAM_GROUP_MIGRATED' WHERE id=$1",[reminder.id]);
    await reminderRepository.update(auth,reminder.id,{enabled:false,operationKey:'manual-pause-after-migration'});
    expect((await database().query('SELECT status,last_error_code FROM reminders WHERE id=$1',[reminder.id])).rows[0])
      .toEqual({status:'paused',last_error_code:null});
  });

});
