/**
 * Утренний обзор.
 *
 * Проверяется: ночью молчит, выключенный не приходит, пустой день не тратит ни предел, ни заявку,
 * дважды за сутки не уходит, отказ Telegram возвращает заявку, а неизвестный исход — нет.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createDailyOverviewDispatcher,
  type DailyOverviewRecipient,
} from "./daily-overview-dispatch.js";
import { MemoryReviewOwnerAlertTransportError } from "../memory-review/memory-review-owner-alert-transport.js";

const person: DailyOverviewRecipient = {
  familyId: "family-1",
  firstEver: false,
  settings: { dailyLimit: 3, enabled: true, quietEnd: "08:00", quietStart: "23:00", timezone: "Europe/Moscow" },
  state: { sentToday: 0, unanswered: 0 },
  telegramUserId: "101",
  userId: "user-1",
};
const morning = new Date("2026-09-12T06:10:00.000Z");

function dependencies(overrides: Partial<Parameters<typeof createDailyOverviewDispatcher>[0]> = {}) {
  return {
    claim: vi.fn().mockResolvedValue(true),
    deliver: vi.fn().mockResolvedValue(undefined),
    personalTime: vi.fn().mockResolvedValue(null),
    overview: vi.fn().mockResolvedValue({
      overdue: [{ source: "Семья", title: "Оплатить счёт" }], promised: [], today: [],
    }),
    recipients: vi.fn().mockResolvedValue([person]),
    release: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("createDailyOverviewDispatcher", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends the morning overview to the person's own chat", async () => {
    const deps = dependencies();
    await expect(createDailyOverviewDispatcher(deps)(morning)).resolves.toBe(1);
    expect(deps.deliver).toHaveBeenCalledWith({
      chatId: "101", text: expect.stringContaining("Оплатить счёт"),
    });
  });

  it("explains itself and names the switch the first time it ever speaks", async () => {
    const deps = dependencies({
      recipients: vi.fn().mockResolvedValue([{ ...person, firstEver: true }]),
    });
    await createDailyOverviewDispatcher(deps)(morning);
    expect(deps.deliver).toHaveBeenCalledWith({
      chatId: "101", text: expect.stringContaining("не пиши мне первым"),
    });
    // Второй раз объяснение не повторяется: человек его уже прочитал.
    const later = dependencies({ deliver: vi.fn().mockResolvedValue(undefined) });
    await createDailyOverviewDispatcher(later)(morning);
    expect(later.deliver).toHaveBeenCalledWith({
      chatId: "101", text: expect.not.stringContaining("не пиши мне первым"),
    });
  });

  it("keeps quiet while the person is in their own time", async () => {
    const deps = dependencies({ personalTime: vi.fn().mockResolvedValue("Зал") });
    await expect(createDailyOverviewDispatcher(deps)(morning)).resolves.toBe(0);
    expect(deps.claim).not.toHaveBeenCalled();
  });

  it("stays quiet before the morning hour of that person", async () => {
    const deps = dependencies();
    // 04:10 по Москве: человек спит, и его тихие часы тут ни при чём.
    await expect(createDailyOverviewDispatcher(deps)(new Date("2026-09-12T01:10:00.000Z")))
      .resolves.toBe(0);
    expect(deps.overview).not.toHaveBeenCalled();
  });

  it("respects the switch and the pause without even looking at the day", async () => {
    for (const recipient of [
      { ...person, settings: { ...person.settings, enabled: false } },
      { ...person, state: { sentToday: 0, unanswered: 3 } },
      { ...person, state: { sentToday: 3, unanswered: 0 } },
    ]) {
      const deps = dependencies({ recipients: vi.fn().mockResolvedValue([recipient]) });
      await expect(createDailyOverviewDispatcher(deps)(morning)).resolves.toBe(0);
      expect(deps.overview).not.toHaveBeenCalled();
      expect(deps.claim).not.toHaveBeenCalled();
    }
  });

  it("spends neither the claim nor the daily limit on a day with nothing in it", async () => {
    const deps = dependencies({
      personalTime: vi.fn().mockResolvedValue(null),
    overview: vi.fn().mockResolvedValue({ overdue: [], promised: [], today: [] }),
    });
    await expect(createDailyOverviewDispatcher(deps)(morning)).resolves.toBe(0);
    expect(deps.claim).not.toHaveBeenCalled();
    expect(deps.deliver).not.toHaveBeenCalled();
  });

  it("does not send a second overview in the same day", async () => {
    const deps = dependencies({ claim: vi.fn().mockResolvedValue(false) });
    await expect(createDailyOverviewDispatcher(deps)(morning)).resolves.toBe(0);
    expect(deps.deliver).not.toHaveBeenCalled();
  });

  it("returns the claim when Telegram refuses and keeps it when the answer is lost", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const refused = dependencies({
      deliver: vi.fn().mockRejectedValue(
        new MemoryReviewOwnerAlertTransportError("failed", "AGENT_TELEGRAM_DELIVERY_REJECTED", "403"),
      ),
    });
    await createDailyOverviewDispatcher(refused)(morning);
    expect(refused.release).toHaveBeenCalledWith(person, "2026-09-12");

    const lost = dependencies({ deliver: vi.fn().mockRejectedValue(new Error("socket hang up")) });
    await createDailyOverviewDispatcher(lost)(morning);
    expect(lost.release).not.toHaveBeenCalled();
  });
});
