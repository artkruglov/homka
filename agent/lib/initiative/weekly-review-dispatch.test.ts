/**
 * Диспетчер недельного обзора: только воскресный вечер человека, общее правило инициативы и личное
 * время важнее содержания, пустой обзор не занимает неделю, отказ Telegram заявку не возвращает.
 */
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";

import { MemoryReviewOwnerAlertTransportError } from "../memory-review/memory-review-owner-alert-transport.js";
import type { BoardTask } from "../task-board.js";
import { createWeeklyReviewDispatcher, type WeeklyReviewDispatcherDependencies } from "./weekly-review-dispatch.js";
import type { WeeklyReviewRecipient } from "./weekly-review-repository.js";

// Воскресенье 27 сентября 2026, 19:00 по Москве.
const NOW = new Date("2026-09-27T16:00:00Z");
const overdue: BoardTask = {
  dueAt: null, dueOn: "2026-09-20", kind: "task", listName: null, source: "Личное",
  status: "accepted", title: "Записаться к врачу",
};
const person: WeeklyReviewRecipient = {
  enabled: true,
  familyId: "family-1",
  settings: { dailyLimit: 3, enabled: true, quietEnd: "08:00", quietStart: "23:00", timezone: "Europe/Moscow" },
  state: { sentToday: 0, unanswered: 0 },
  telegramUserId: "101",
  userId: "user-1",
};

function dependencies(overrides: Partial<WeeklyReviewDispatcherDependencies> = {}) {
  return {
    claim: vi.fn().mockResolvedValue("ref-1"),
    personalTime: vi.fn().mockResolvedValue(null),
    recipients: vi.fn().mockResolvedValue([person]),
    record: vi.fn().mockResolvedValue(undefined),
    review: vi.fn().mockResolvedValue({
      closedLastWeek: 2, now: NOW, tasks: [overdue], timezone: "Europe/Moscow", waiting: [],
    }),
    send: vi.fn().mockResolvedValue("777"),
    ...overrides,
  };
}

describe("weekly review dispatcher", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends the Sunday evening review and journals it", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const deps = dependencies();

    await expect(createWeeklyReviewDispatcher(deps)(NOW)).resolves.toBe(1);

    expect(deps.claim).toHaveBeenCalledWith(person, "2026-09-27", NOW);
    const text = ((deps.send as Mock).mock.calls[0]![0] as { text: string }).text;
    expect(text).toContain("Записаться к врачу");
    expect(text).toContain("Что давит?");
    expect(deps.send).toHaveBeenCalledWith({ chatId: "101", text });
    expect(deps.record).toHaveBeenCalledWith(expect.objectContaining({
      deliveryRef: "ref-1", messageId: "777", sourceKind: "weekly_review", text,
    }));
  });

  it("waits for Sunday evening in the person's own zone", async () => {
    for (const at of [
      // Суббота 19:00 и воскресенье 12:00 по Москве.
      new Date("2026-09-26T16:00:00Z"),
      new Date("2026-09-27T09:00:00Z"),
      // Воскресенье 21:00: обзор не ночное чтение.
      new Date("2026-09-27T18:00:00Z"),
    ]) {
      const deps = dependencies();
      await expect(createWeeklyReviewDispatcher(deps)(at)).resolves.toBe(0);
      expect(deps.review).not.toHaveBeenCalled();
    }
    // Ровно 18:00 по Москве это уже вечер.
    const early = dependencies();
    await expect(createWeeklyReviewDispatcher(early)(new Date("2026-09-27T15:00:00Z"))).resolves.toBe(1);
  });

  it("writes to nobody who has not asked for the review", async () => {
    for (const enabled of [null, false]) {
      const deps = dependencies({ recipients: vi.fn().mockResolvedValue([{ ...person, enabled }]) });
      await expect(createWeeklyReviewDispatcher(deps)(NOW)).resolves.toBe(0);
      expect(deps.review).not.toHaveBeenCalled();
    }
  });

  it("obeys the initiative switch, the pause after silence and personal time", async () => {
    for (const recipient of [
      { ...person, settings: { ...person.settings, enabled: false } },
      { ...person, state: { sentToday: 0, unanswered: 3 } },
    ]) {
      const deps = dependencies({ recipients: vi.fn().mockResolvedValue([recipient]) });
      await expect(createWeeklyReviewDispatcher(deps)(NOW)).resolves.toBe(0);
      expect(deps.claim).not.toHaveBeenCalled();
    }
    const busy = dependencies({ personalTime: vi.fn().mockResolvedValue("Бег") });
    await expect(createWeeklyReviewDispatcher(busy)(NOW)).resolves.toBe(0);
    expect(busy.review).not.toHaveBeenCalled();
  });

  it("does not spend the week's claim on an empty review", async () => {
    const deps = dependencies({
      review: vi.fn().mockResolvedValue({
        closedLastWeek: 4, now: NOW, tasks: [], timezone: "Europe/Moscow", waiting: [],
      }),
    });

    await expect(createWeeklyReviewDispatcher(deps)(NOW)).resolves.toBe(0);
    expect(deps.claim).not.toHaveBeenCalled();
  });

  it("sends nothing when another tick already claimed the week", async () => {
    const deps = dependencies({ claim: vi.fn().mockResolvedValue(null) });

    await expect(createWeeklyReviewDispatcher(deps)(NOW)).resolves.toBe(0);
    expect(deps.send).not.toHaveBeenCalled();
  });

  it("keeps the week's claim after any failed delivery, so a blocked chat is not retried all evening", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const refused = dependencies({
      send: vi.fn().mockRejectedValue(new MemoryReviewOwnerAlertTransportError("failed", "AGENT_X", "403")),
    });
    await expect(createWeeklyReviewDispatcher(refused)(NOW)).resolves.toBe(0);
    expect(refused.record).not.toHaveBeenCalled();
    expect(error.mock.calls[0]![0]).toContain("AGENT_WEEKLY_REVIEW_FAILED");

    const lost = dependencies({ send: vi.fn().mockRejectedValue(new Error("socket hang up")) });
    await createWeeklyReviewDispatcher(lost)(NOW);
    expect(error.mock.calls.at(-1)![0]).toContain("AGENT_WEEKLY_REVIEW_AMBIGUOUS");
  });
});
