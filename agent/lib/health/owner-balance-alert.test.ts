/**
 * Low DeepSeek balance alert tests.
 *
 * Constructs covered:
 * - A low or blocked balance reaches the owner once per UTC day through a claim; a healthy or
 *   unreadable balance sends nothing and takes no claim.
 * - Quiet hours postpone the alert; a Telegram refusal releases the claim, an unclear delivery does not.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { MemoryReviewOwnerAlertTransportError } from "../memory-review/memory-review-owner-alert-transport.js";
import { createOwnerBalanceAlertDispatcher } from "./owner-balance-alert.js";

const owner = { familyId: "family-1", ownerTelegramUserId: "101", quietEnd: null, quietStart: null, timezone: "UTC" };

function dependencies(overrides: Partial<Parameters<typeof createOwnerBalanceAlertDispatcher>[0]> = {}) {
  return {
    abandon: vi.fn().mockResolvedValue(undefined),
    balance: vi.fn().mockResolvedValue({ available: true, totalUsd: 1.2 }),
    claim: vi.fn().mockResolvedValue(true),
    complete: vi.fn().mockResolvedValue(undefined),
    deliver: vi.fn().mockResolvedValue(undefined),
    recipients: vi.fn().mockResolvedValue([owner]),
    release: vi.fn().mockResolvedValue(undefined),
    thresholdUsd: 2,
    ...overrides,
  };
}

describe("createOwnerBalanceAlertDispatcher", () => {
  afterEach(() => vi.restoreAllMocks());
  const now = new Date("2026-09-14T12:00:00.000Z");

  it("tells the owner once a day that the balance is low", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const deps = dependencies();
    await expect(createOwnerBalanceAlertDispatcher(deps)(now)).resolves.toBe(1);
    expect(deps.claim).toHaveBeenCalledWith("family-1", "2026-09-14", now);
    expect(deps.deliver).toHaveBeenCalledWith({
      chatId: "101",
      text: "DeepSeek: баланс 1,20 $, ниже порога 2,00 $. Пополните счёт, иначе бот перестанет отвечать.",
    });
    expect(deps.complete).toHaveBeenCalledWith("family-1", "2026-09-14", now);
  });

  it("does nothing for a healthy or unreadable balance", async () => {
    for (const balance of [{ available: true, totalUsd: 5 }, null]) {
      const deps = dependencies({ balance: vi.fn().mockResolvedValue(balance) });
      await expect(createOwnerBalanceAlertDispatcher(deps)(now)).resolves.toBe(0);
      expect(deps.recipients).not.toHaveBeenCalled();
      expect(deps.claim).not.toHaveBeenCalled();
    }
  });

  it("waits out quiet hours and does not send a claimed alert twice", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const sleeping = dependencies({
      recipients: vi.fn().mockResolvedValue([{ ...owner, quietEnd: "08:00", quietStart: "22:00", timezone: "Europe/Moscow" }]),
    });
    await expect(createOwnerBalanceAlertDispatcher(sleeping)(new Date("2026-09-14T21:00:00.000Z"))).resolves.toBe(0);
    expect(sleeping.claim).not.toHaveBeenCalled();
    const claimed = dependencies({ claim: vi.fn().mockResolvedValue(false) });
    await expect(createOwnerBalanceAlertDispatcher(claimed)(now)).resolves.toBe(0);
    expect(claimed.deliver).not.toHaveBeenCalled();
  });

  it("releases a refused delivery and keeps an unclear one terminal", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const refused = dependencies({
      deliver: vi.fn().mockRejectedValue(new MemoryReviewOwnerAlertTransportError("failed", "AGENT_TELEGRAM_DELIVERY_REJECTED", "403")),
    });
    await createOwnerBalanceAlertDispatcher(refused)(now);
    expect(refused.release).toHaveBeenCalledWith("family-1", "2026-09-14");
    const unclear = dependencies({ deliver: vi.fn().mockRejectedValue(new Error("socket hang up")) });
    await createOwnerBalanceAlertDispatcher(unclear)(now);
    expect(unclear.release).not.toHaveBeenCalled();
    expect(unclear.abandon).toHaveBeenCalledWith("family-1", "2026-09-14", "AGENT_OWNER_BALANCE_ALERT_AMBIGUOUS");
  });
});
