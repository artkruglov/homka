/**
 * Диспетчер коуча: общее правило инициативы и личное время важнее повода, заявка до отправки,
 * отказ Telegram заявку не возвращает, отправленное касание попадает в журнал доставок.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { MemoryReviewOwnerAlertTransportError } from "../memory-review/memory-review-owner-alert-transport.js";
import { COACH_INVITE_TEXT } from "./coach.js";
import { createCoachDispatcher, type CoachDispatcherDependencies } from "./coach-dispatch.js";
import type { CoachRecipient } from "./coach-repository.js";

// Среда 23 сентября 2026, 15:00 по Москве.
const NOW = new Date("2026-09-23T12:00:00Z");
const person: CoachRecipient = {
  facts: {
    enabled: null, familyRituals: 0, invited: false, lastByReason: {}, lastTouchAt: null,
    openDecision: null, personalWindows: 0, quietRitual: null, relation: "partner", touchesLastWeek: 0,
    weeklyReviewEnabled: false,
  },
  coachEnabled: true,
  familyId: "family-1",
  weeklyReviewEnabled: false,
  relation: "partner",
  settings: { dailyLimit: 3, enabled: true, quietEnd: "08:00", quietStart: "23:00", timezone: "Europe/Moscow" },
  state: { sentToday: 0, unanswered: 0 },
  telegramUserId: "101",
  userId: "user-1",
};

function dependencies(overrides: Partial<CoachDispatcherDependencies> = {}) {
  return {
    claim: vi.fn().mockResolvedValue("ref-1"),
    personalTime: vi.fn().mockResolvedValue(null),
    recipients: vi.fn().mockResolvedValue([person]),
    record: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue("777"),
    ...overrides,
  };
}

describe("coach dispatcher", () => {
  afterEach(() => vi.restoreAllMocks());

  it("invites a person with a private chat and journals the invitation", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const deps = dependencies();

    await expect(createCoachDispatcher(deps)(NOW)).resolves.toBe(1);

    expect(deps.claim).toHaveBeenCalledWith(person, "2026-09-23",
      { reason: "invite", subject: null, text: COACH_INVITE_TEXT }, NOW);
    expect(deps.send).toHaveBeenCalledWith({ chatId: "101", text: COACH_INVITE_TEXT });
    expect(deps.record).toHaveBeenCalledWith(expect.objectContaining({
      deliveryRef: "ref-1", messageId: "777", sourceKind: "coach", text: COACH_INVITE_TEXT,
    }));
  });

  it("obeys the initiative switch, the pause after silence and personal time", async () => {
    for (const recipient of [
      { ...person, settings: { ...person.settings, enabled: false } },
      { ...person, state: { sentToday: 0, unanswered: 3 } },
    ]) {
      const deps = dependencies({ recipients: vi.fn().mockResolvedValue([recipient]) });
      await expect(createCoachDispatcher(deps)(NOW)).resolves.toBe(0);
      expect(deps.claim).not.toHaveBeenCalled();
    }
    const busy = dependencies({ personalTime: vi.fn().mockResolvedValue("Бег") });
    await expect(createCoachDispatcher(busy)(NOW)).resolves.toBe(0);
    expect(busy.claim).not.toHaveBeenCalled();
  });

  it("does not look for a reason at night in the person's zone", async () => {
    const deps = dependencies();
    // 01:00 по Москве.
    await expect(createCoachDispatcher(deps)(new Date("2026-09-22T22:00:00Z"))).resolves.toBe(0);
    expect(deps.claim).not.toHaveBeenCalled();
  });

  it("sends nothing when another tick already claimed the day", async () => {
    const deps = dependencies({ claim: vi.fn().mockResolvedValue(null) });
    await expect(createCoachDispatcher(deps)(NOW)).resolves.toBe(0);
    expect(deps.send).not.toHaveBeenCalled();
  });

  it("keeps the day's claim after any failed delivery, so a blocked chat is not retried all day", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const refused = dependencies({
      send: vi.fn().mockRejectedValue(new MemoryReviewOwnerAlertTransportError("failed", "AGENT_X", "403")),
    });
    await expect(createCoachDispatcher(refused)(NOW)).resolves.toBe(0);
    expect(refused.record).not.toHaveBeenCalled();
    expect(error.mock.calls[0]![0]).toContain("AGENT_COACH_TOUCH_FAILED");

    const lost = dependencies({ send: vi.fn().mockRejectedValue(new Error("socket hang up")) });
    await createCoachDispatcher(lost)(NOW);
    expect(error.mock.calls.at(-1)![0]).toContain("AGENT_COACH_TOUCH_AMBIGUOUS");
  });
});
