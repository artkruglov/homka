/**
 * Диспетчер уведомлений: правило инициативы и личное время важнее ожидания, заявка до отправки,
 * неудачная доставка заявку не возвращает, отправленное попадает в журнал доставок.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { MemoryReviewOwnerAlertTransportError } from "../memory-review/memory-review-owner-alert-transport.js";
import {
  createPartnerAlertDispatcher, type PartnerAlertDispatcherDependencies,
} from "./partner-alert-dispatch.js";
import type { PartnerAlertRecipient } from "./partner-alert-repository.js";

// Среда 23 сентября 2026, 15:00 по Москве.
const NOW = new Date("2026-09-23T12:00:00Z");
const person: PartnerAlertRecipient = {
  coachEnabled: null,
  familyId: "family-1",
  weeklyReviewEnabled: null,
  relation: null,
  settings: { dailyLimit: 3, enabled: true, quietEnd: "08:00", quietStart: "23:00", timezone: "Europe/Moscow" },
  state: { sentToday: 0, unanswered: 0 },
  telegramUserId: "101",
  userId: "user-1",
};
const waiting = {
  items: [{ from: "Саша", kind: "task_proposed" as const, repeated: false, subjectId: "s1", title: "Забрать посылку" }],
  pending: 0,
};

function dependencies(overrides: Partial<PartnerAlertDispatcherDependencies> = {}) {
  return {
    claim: vi.fn().mockResolvedValue("ref-1"),
    pending: vi.fn().mockResolvedValue(waiting),
    personalTime: vi.fn().mockResolvedValue(null),
    recipients: vi.fn().mockResolvedValue([person]),
    record: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue("777"),
    ...overrides,
  };
}

describe("partner alert dispatcher", () => {
  afterEach(() => vi.restoreAllMocks());

  it("tells the person what waits and journals it", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const deps = dependencies();

    await expect(createPartnerAlertDispatcher(deps)(NOW)).resolves.toBe(1);

    expect(deps.send).toHaveBeenCalledWith({
      chatId: "101", text: expect.stringContaining("Дело (Саша): «Забрать посылку»"),
    });
    expect(deps.claim).toHaveBeenCalledWith(person, "2026-09-23", waiting.items, NOW);
    expect(deps.record).toHaveBeenCalledWith(expect.objectContaining({
      deliveryRef: "ref-1", messageId: "777", sourceKind: "partner_alert",
    }));
  });

  it("works for a person who never turned the coach on: this is their own business", async () => {
    const deps = dependencies({
      recipients: vi.fn().mockResolvedValue([{ ...person, coachEnabled: false }]),
    });
    vi.spyOn(console, "info").mockImplementation(() => undefined);

    await expect(createPartnerAlertDispatcher(deps)(NOW)).resolves.toBe(1);
  });

  it("obeys the initiative switch, the pause after silence and personal time", async () => {
    for (const recipient of [
      { ...person, settings: { ...person.settings, enabled: false } },
      { ...person, state: { sentToday: 0, unanswered: 3 } },
    ]) {
      const deps = dependencies({ recipients: vi.fn().mockResolvedValue([recipient]) });
      await expect(createPartnerAlertDispatcher(deps)(NOW)).resolves.toBe(0);
      expect(deps.claim).not.toHaveBeenCalled();
    }
    const busy = dependencies({ personalTime: vi.fn().mockResolvedValue("Бег") });
    await expect(createPartnerAlertDispatcher(busy)(NOW)).resolves.toBe(0);
    expect(busy.claim).not.toHaveBeenCalled();
  });

  it("says nothing when nothing waits", async () => {
    const deps = dependencies({ pending: vi.fn().mockResolvedValue({ items: [], pending: 0 }) });
    await expect(createPartnerAlertDispatcher(deps)(NOW)).resolves.toBe(0);
    expect(deps.claim).not.toHaveBeenCalled();
  });

  it("sends nothing when today's claim is taken and keeps it after a failure", async () => {
    const taken = dependencies({ claim: vi.fn().mockResolvedValue(null) });
    await expect(createPartnerAlertDispatcher(taken)(NOW)).resolves.toBe(0);
    expect(taken.send).not.toHaveBeenCalled();

    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const refused = dependencies({
      send: vi.fn().mockRejectedValue(new MemoryReviewOwnerAlertTransportError("failed", "AGENT_X", "403")),
    });
    await expect(createPartnerAlertDispatcher(refused)(NOW)).resolves.toBe(0);
    expect(refused.record).not.toHaveBeenCalled();
    expect(error.mock.calls[0]![0]).toContain("AGENT_PARTNER_ALERT_FAILED");
  });
});
