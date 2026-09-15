/**
 * Owner-private memory-review alert dispatcher tests.
 *
 * Constructs covered:
 * - `createMemoryReviewOwnerAlertDispatcher`: exact private warning delivery and durable outcomes.
 * - Definite Telegram rejection and ambiguous network outcomes are terminal and never retried.
 */
import { describe, expect, it, vi } from "vitest";

import {
  createMemoryReviewOwnerAlertDispatcher,
  MemoryReviewOwnerAlertTransportError,
  type MemoryReviewOwnerAlertClaim,
} from "./memory-review-owner-alert-dispatcher.js";

const alert: MemoryReviewOwnerAlertClaim = {
  alertId: "00000000-0000-4000-8000-000000000080",
  batchId: "00000000-0000-4000-8000-000000000050",
  deliveryToken: "00000000-0000-4000-8000-000000000090",
  diagnosticCode: "AGENT_MEMORY_REVIEW_SESSION_FAILED_AMBIGUOUS",
  fromSequence: "5540",
  groupTitle: "Клуб разработчиков",
  ownerTelegramUserId: "101",
  throughSequence: "5589",
};

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    claimPending: vi.fn().mockResolvedValue([alert]),
    deliver: vi.fn().mockResolvedValue(undefined),
    markDelivered: vi.fn().mockResolvedValue(undefined),
    markFailed: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("memory review owner alert dispatcher", () => {
  it("delivers one Russian warning to the current owner's private chat", async () => {
    const fixture = dependencies();

    await expect(createMemoryReviewOwnerAlertDispatcher(fixture)()).resolves.toBe(1);

    expect(fixture.deliver).toHaveBeenCalledWith({
      chatId: "101",
      text: expect.stringMatching(
        /AGENT_MEMORY_REVIEW_BLOCKED[\s\S]*Клуб разработчиков[\s\S]*5540–5589/u,
      ),
    });
    expect(fixture.markDelivered).toHaveBeenCalledWith(alert);
    expect(fixture.markFailed).not.toHaveBeenCalled();
  });

  it("tells the owner that a skipped pass will not be revisited", async () => {
    const fixture = dependencies({
      claimPending: vi.fn().mockResolvedValue([{
        ...alert,
        diagnosticCode: "AGENT_MEMORY_REVIEW_PASS_SKIPPED",
      }]),
    });

    await expect(createMemoryReviewOwnerAlertDispatcher(fixture)()).resolves.toBe(1);

    // Источники такого пакета уже отпущены, поэтому обещать их сохранность нельзя.
    const delivered = fixture.deliver.mock.calls[0]![0] as { text: string };
    expect(delivered.text).toMatch(
      /AGENT_MEMORY_REVIEW_PASS_SKIPPED[\s\S]*Клуб разработчиков[\s\S]*5540–5589/u,
    );
    expect(delivered.text).not.toContain("сохранены");
  });

  it("records a definite Telegram rejection without retry", async () => {
    const fixture = dependencies({
      deliver: vi.fn().mockRejectedValue(new MemoryReviewOwnerAlertTransportError(
        "failed",
        "AGENT_MEMORY_REVIEW_OWNER_ALERT_TELEGRAM_REJECTED",
        "Telegram отклонил уведомление владельца",
      )),
    });

    await expect(createMemoryReviewOwnerAlertDispatcher(fixture)()).resolves.toBe(1);

    expect(fixture.markFailed).toHaveBeenCalledWith(alert, {
      diagnosticCode: "AGENT_MEMORY_REVIEW_OWNER_ALERT_TELEGRAM_REJECTED",
      status: "failed",
    });
    expect(fixture.markDelivered).not.toHaveBeenCalled();
  });

  it("records an unknown network outcome as ambiguous and continues with the next alert", async () => {
    const second = { ...alert, alertId: "00000000-0000-4000-8000-000000000081" };
    const fixture = dependencies({
      claimPending: vi.fn().mockResolvedValue([alert, second]),
      deliver: vi.fn()
        .mockRejectedValueOnce(new Error("connection reset"))
        .mockResolvedValueOnce(undefined),
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(createMemoryReviewOwnerAlertDispatcher(fixture)()).resolves.toBe(2);

    expect(fixture.markFailed).toHaveBeenCalledWith(alert, {
      diagnosticCode: "AGENT_MEMORY_REVIEW_OWNER_ALERT_DELIVERY_AMBIGUOUS",
      status: "ambiguous",
    });
    expect(fixture.markDelivered).toHaveBeenCalledWith(second);
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining(
      "AGENT_MEMORY_REVIEW_OWNER_ALERT_DELIVERY_AMBIGUOUS",
    ));
    consoleError.mockRestore();
  });
});
