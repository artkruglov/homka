/**
 * Reminder dispatcher orchestration tests.
 *
 * Constructs covered:
 * - Side-effect marker precedes Telegram delivery and successful completion.
 * - Delivery failures become terminal records without hidden retry.
 * - Timeline failures cannot reclassify a confirmed delivery as failed.
 * - A dropped database connection after Telegram accepted the message retries only the bookkeeping.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ClaimedReminder } from "./reminder-dispatch-repository.js";
import { createReminderDispatcher } from "./reminder-dispatcher.js";

const job: ClaimedReminder = {
  familyId: "00000000-0000-4000-8000-000000000010",
  forumTopicId: null,
  content: "Позвонить врачу",
  delayed: false,
  dueAt: "2026-07-13T06:00:00.000Z",
  id: "00000000-0000-4000-8000-000000000001",
  leaseToken: "00000000-0000-4000-8000-000000000002",
  messageThreadId: null,
  groupId: null,
  ownerUserId: "00000000-0000-4000-8000-000000000011",
  scope: "personal",
  telegramChatId: "101",
  timezone: "Europe/Moscow",
};

describe("reminder dispatcher", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries completion after a dropped database connection instead of failing a sent reminder", async () => {
    vi.useFakeTimers();
    const dropped = Object.assign(new Error("terminating connection due to administrator command"), { code: "57P01" });
    const repository = {
      claimDue: vi.fn().mockResolvedValue([job]),
      complete: vi.fn().mockRejectedValueOnce(dropped).mockResolvedValueOnce(undefined),
      fail: vi.fn(),
      markDispatchStarted: vi.fn(),
    };
    const deliver = vi.fn().mockResolvedValue({ messageId: "55", text: "Напоминание" });
    const dispatch = createReminderDispatcher({ deliver, repository, timeline: { recordAgentResponse: vi.fn() } });

    const dispatched = dispatch(new Date("2026-07-13T06:00:00.000Z"));
    await vi.runAllTimersAsync();

    await expect(dispatched).resolves.toBe(1);
    expect(deliver).toHaveBeenCalledOnce();
    expect(repository.complete).toHaveBeenCalledTimes(2);
    expect(repository.fail).not.toHaveBeenCalled();
  });

  it("leaves a sent reminder to lease recovery when the database stays unreachable", async () => {
    vi.useFakeTimers();
    const dropped = new Error("Connection terminated unexpectedly");
    const repository = {
      claimDue: vi.fn().mockResolvedValue([job]),
      complete: vi.fn().mockRejectedValue(dropped),
      fail: vi.fn(),
      markDispatchStarted: vi.fn(),
    };
    const deliver = vi.fn().mockResolvedValue({ messageId: "55", text: "Напоминание" });
    const dispatch = createReminderDispatcher({ deliver, repository, timeline: { recordAgentResponse: vi.fn() } });

    const dispatched = dispatch(new Date("2026-07-13T06:00:00.000Z"));
    const settled = expect(dispatched).rejects.toBe(dropped);
    await vi.runAllTimersAsync();

    await settled;
    // The message was sent: recording it as a Telegram delivery failure would be false.
    expect(deliver).toHaveBeenCalledOnce();
    expect(repository.fail).not.toHaveBeenCalled();
  });

  it.each(["timeline", "failure receipt"])("finishes the claimed batch despite a failed %s write", async (stage) => {
    const first = { ...job, groupId: "00000000-0000-4000-8000-000000000012" };
    const second = { ...job, id: "00000000-0000-4000-8000-000000000003" };
    const persistenceError = new Error("receipt storage unavailable");
    const repository = {
      claimDue: vi.fn().mockResolvedValue([first, second]),
      complete: vi.fn(),
      fail: vi.fn().mockRejectedValue(persistenceError),
      markDispatchStarted: vi.fn(),
    };
    const receipt = { messageId: "55", text: "Напоминание" };
    const deliver = vi.fn().mockResolvedValue(receipt);
    if (stage === "failure receipt") deliver.mockRejectedValueOnce(new Error("Telegram unavailable"));
    const dispatch = createReminderDispatcher({
      deliver, repository,
      timeline: { recordAgentResponse: vi.fn().mockRejectedValue(persistenceError) },
    });

    await expect(dispatch()).rejects.toBe(persistenceError);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(repository.markDispatchStarted).toHaveBeenCalledWith(second.id, second.leaseToken);
    expect(repository.complete).toHaveBeenCalledWith(second, expect.any(Date), receipt);
    if (stage === "timeline") expect(repository.fail).not.toHaveBeenCalled();
    else expect(repository.fail).toHaveBeenCalledTimes(1);
  });

  it("marks dispatch before delivery and completes the exact lease", async () => {
    const order: string[] = [];
    const groupJob = { ...job, groupId: "00000000-0000-4000-8000-000000000012" };
    const repository = {
      claimDue: vi.fn().mockResolvedValue([groupJob]),
      complete: vi.fn().mockImplementation(async () => { order.push("complete"); }),
      fail: vi.fn(),
      markDispatchStarted: vi.fn().mockImplementation(async () => { order.push("mark"); }),
    };
    const receipt = { messageId: "55", text: "Напоминание:\n\nПозвонить врачу" };
    const timeline = { recordAgentResponse: vi.fn().mockImplementation(async () => {
      order.push("timeline");
    }) };
    const deliver = vi.fn().mockImplementation(async () => {
      order.push("deliver");
      return receipt;
    });
    const dispatch = createReminderDispatcher({ deliver, repository, timeline });

    await expect(dispatch(new Date("2026-07-13T06:00:00.000Z"))).resolves.toBe(1);
    expect(order).toEqual(["mark", "deliver", "complete", "timeline"]);
    expect(repository.complete).toHaveBeenCalledWith(groupJob, expect.any(Date), receipt);
    expect(repository.fail).not.toHaveBeenCalled();
  });

  it("records one terminal failure when Telegram delivery fails", async () => {
    const repository = {
      claimDue: vi.fn().mockResolvedValue([job]),
      complete: vi.fn(),
      fail: vi.fn(),
      markDispatchStarted: vi.fn(),
    };
    const dispatch = createReminderDispatcher({
      deliver: vi.fn().mockRejectedValue(new Error("network unavailable")),
      repository,
      timeline: { recordAgentResponse: vi.fn() },
    });

    await expect(dispatch(new Date("2026-07-13T06:00:00.000Z"))).resolves.toBe(1);
    expect(repository.fail).toHaveBeenCalledWith(job, "AGENT_REMINDER_TELEGRAM_DELIVERY_FAILED");
    expect(repository.complete).not.toHaveBeenCalled();
  });

  it("does not fail or redeliver a reminder when timeline persistence fails after completion", async () => {
    const groupJob = { ...job, groupId: "00000000-0000-4000-8000-000000000012" };
    const repository = {
      claimDue: vi.fn().mockResolvedValue([groupJob]),
      complete: vi.fn(),
      fail: vi.fn(),
      markDispatchStarted: vi.fn(),
    };
    const dispatch = createReminderDispatcher({
      deliver: vi.fn().mockResolvedValue({ messageId: "55", text: "Напоминание" }),
      repository,
      timeline: { recordAgentResponse: vi.fn().mockRejectedValue(new Error("timeline unavailable")) },
    });

    await expect(dispatch(new Date("2026-07-13T06:00:00.000Z")))
      .rejects.toThrowError("timeline unavailable");
    expect(repository.complete).toHaveBeenCalledOnce();
    expect(repository.fail).not.toHaveBeenCalled();
  });
});
