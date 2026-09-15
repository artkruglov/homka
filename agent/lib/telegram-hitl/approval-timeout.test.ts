/**
 * Telegram HITL approval timeout tests.
 *
 * Constructs covered:
 * - `createApprovalTimeoutResolver`: cancels an unanswered request and unblocks the parked turn.
 * - The response carries revalidated Telegram auth, without which the resumed turn cannot deliver.
 * - Durable terminal state is written only after Eve accepts the synthetic cancellation.
 * - A failed Eve response releases the lease so the next sweep retries instead of freezing the chat.
 * - Neither a failed settlement nor a failed lease release abandons the rest of the leased batch.
 * - A question is answered as "no answer", not as an option the user never saw.
 * - Every expired request of one session is cancelled in one response, and a shared prompt is
 *   rewritten once.
 */
import type { SessionAuthContext } from "eve/context";
import { describe, expect, it, vi } from "vitest";

import { createApprovalTimeoutResolver, type TimedOutApprovalClaim } from "./approval-timeout.js";

const NOW = new Date("2026-08-24T10:00:00.000Z");

const VERIFIED_AUTH = {
  attributes: {
    applicationSessionId: "app-session-1",
    familyId: "family-1",
    memoryScopes: ["personal", "family"],
    role: "owner",
    telegramActorId: "649624756",
    telegramActorKind: "telegram_user",
    telegramChatId: "649624756",
    telegramChatType: "private",
    telegramMessageId: "2801",
    telegramUserId: "649624756",
  },
  authenticator: "telegram",
  principalId: "user-1",
  principalType: "user",
} as unknown as SessionAuthContext;

function claim(overrides: Partial<TimedOutApprovalClaim> = {}): TimedOutApprovalClaim {
  return {
    applicationSessionId: "app-session-1",
    auth: VERIFIED_AUTH,
    eveSessionId: "wrun_parked",
    id: "approval-1",
    kind: "tool-approval",
    leaseToken: "lease-1",
    promptText: "Подтвердите действие: исправить запись в памяти.",
    requestId: "aitxt-request-1",
    telegramChatId: "649624756",
    telegramMessageId: "2801",
    toolName: "manage_memory",
    ...overrides,
  };
}

function dependencies() {
  const respond = vi.fn().mockResolvedValue({ sessionId: "wrun_parked", status: "accepted" });
  return {
    respond,
    values: {
      attachSession: vi.fn().mockReturnValue({ respond }),
      finalizePrompt: vi.fn().mockResolvedValue(undefined),
      repository: {
        claimExpired: vi.fn().mockResolvedValue([claim()]),
        completeTimeout: vi.fn().mockResolvedValue(true),
        failTimeout: vi.fn().mockResolvedValue(undefined),
      },
    },
  };
}

describe("createApprovalTimeoutResolver", () => {
  it("cancels the exact pending request and tells the model it was a timeout", async () => {
    const { respond, values } = dependencies();

    const resolved = await createApprovalTimeoutResolver(values as never)(NOW);

    expect(resolved).toBe(1);
    expect(values.attachSession).toHaveBeenCalledWith("wrun_parked");
    const [inputResponses, options] = respond.mock.calls[0]!;
    expect(inputResponses).toEqual([{ optionId: "cancel", requestId: "aitxt-request-1" }]);
    const context = (options as { context: string[] }).context.join("\n");
    expect(context).toContain("manage_memory");
    expect(context).toContain("не подтвердил");
    expect(context).toContain("не выполнено");
    // The model must warn the user and must not re-open the same approval on its own.
    expect(context).toMatch(/не запрашивай|не спрашивай/iu);
  });

  it("delivers the revalidated Telegram auth the resumed turn needs", async () => {
    const { respond, values } = dependencies();

    await createApprovalTimeoutResolver(values as never)(NOW);

    // Eve replaces session auth with the delivered auth: an app principal would strip the
    // application context and the resumed turn could no longer answer the user at all.
    const auth = (respond.mock.calls[0]![1] as { auth: SessionAuthContext }).auth;
    expect(auth.authenticator).toBe("telegram");
    expect(auth.attributes).toMatchObject({ applicationSessionId: "app-session-1" });
    expect(auth.principalType).toBe("user");
  });

  it("settles a prompt whose approver can no longer be proven without resuming the turn", async () => {
    const { respond, values } = dependencies();
    values.repository.claimExpired.mockResolvedValue([claim({ auth: null })]);

    await createApprovalTimeoutResolver(values as never)(NOW);

    // Возобновлять ход под недоказанной личностью нельзя, но запрос обязан закрыться,
    // иначе ход остаётся припаркованным, а человек не получает ни ответа, ни предупреждения.
    expect(respond).not.toHaveBeenCalled();
    expect(values.repository.completeTimeout).toHaveBeenCalledTimes(1);
    expect(values.repository.failTimeout).not.toHaveBeenCalled();
    expect(values.finalizePrompt).toHaveBeenCalledTimes(1);
  });

  it("cancels an unprovable request alongside a provable one in the same session", async () => {
    const { respond, values } = dependencies();
    values.repository.claimExpired.mockResolvedValue([
      claim({ auth: null, id: "approval-unprovable", requestId: "aitxt-request-unprovable", telegramMessageId: "2802" }),
      claim(),
    ]);

    await createApprovalTimeoutResolver(values as never)(NOW);

    const [inputResponses] = respond.mock.calls[0]!;
    expect(inputResponses).toEqual([{ optionId: "cancel", requestId: "aitxt-request-1" }]);
    expect(values.repository.completeTimeout).toHaveBeenCalledTimes(2);
    expect(values.finalizePrompt).toHaveBeenCalledTimes(2);
  });

  it("answers an unanswered question without inventing a selected option", async () => {
    const { respond, values } = dependencies();
    values.repository.claimExpired.mockResolvedValue([
      claim({ kind: "question", toolName: "ask_question" }),
    ]);

    await createApprovalTimeoutResolver(values as never)(NOW);

    const [inputResponses] = respond.mock.calls[0]!;
    expect(inputResponses[0]).not.toHaveProperty("optionId");
    expect(inputResponses[0]).toMatchObject({ requestId: "aitxt-request-1" });
  });

  it("writes terminal state only after Eve accepted the cancellation", async () => {
    const { respond, values } = dependencies();
    const order: string[] = [];
    respond.mockImplementation(async () => {
      order.push("respond");
      return { sessionId: "wrun_parked", status: "accepted" };
    });
    values.repository.completeTimeout.mockImplementation(async () => {
      order.push("complete");
      return true;
    });

    await createApprovalTimeoutResolver(values as never)(NOW);

    expect(order).toEqual(["respond", "complete"]);
    expect(values.finalizePrompt).toHaveBeenCalledTimes(1);
  });

  it("releases the lease and keeps the approval retryable when Eve rejects the response", async () => {
    const { respond, values } = dependencies();
    respond.mockRejectedValue(new Error("session is not waiting"));

    const resolved = await createApprovalTimeoutResolver(values as never)(NOW);

    expect(resolved).toBe(0);
    expect(values.repository.completeTimeout).not.toHaveBeenCalled();
    expect(values.repository.failTimeout).toHaveBeenCalledWith(
      expect.objectContaining({ id: "approval-1" }),
      "AGENT_APPROVAL_TIMEOUT_RESPONSE_FAILED",
    );
    expect(values.finalizePrompt).not.toHaveBeenCalled();
  });

  it("settles the row when the parked session no longer exists", async () => {
    const { respond, values } = dependencies();
    const reported = vi.spyOn(console, "error").mockImplementation(() => {});
    respond.mockResolvedValue({ status: "session_not_active" });

    await createApprovalTimeoutResolver(values as never)(NOW);

    // Retrying could never succeed, so the rotation veto is released instead of held forever.
    expect(values.repository.completeTimeout).toHaveBeenCalledTimes(1);
    expect(values.repository.failTimeout).not.toHaveBeenCalled();
    expect(reported.mock.calls[0]![0]).toContain("AGENT_APPROVAL_TIMEOUT_SESSION_INACTIVE");
    reported.mockRestore();
  });

  it("leaves the Telegram prompt untouched when the user answered during the sweep", async () => {
    const { values } = dependencies();
    values.repository.completeTimeout.mockResolvedValue(false);

    const resolved = await createApprovalTimeoutResolver(values as never)(NOW);

    expect(resolved).toBe(0);
    expect(values.finalizePrompt).not.toHaveBeenCalled();
  });

  it("keeps sweeping the batch when one settlement throws", async () => {
    const { values } = dependencies();
    const reported = vi.spyOn(console, "error").mockImplementation(() => {});
    values.repository.claimExpired.mockResolvedValue([
      claim({ id: "approval-1" }),
      claim({ id: "approval-2" }),
    ]);
    values.repository.completeTimeout
      .mockRejectedValueOnce(new Error("deadlock detected"))
      .mockResolvedValue(true);

    const resolved = await createApprovalTimeoutResolver(values as never)(NOW);

    expect(resolved).toBe(1);
    expect(reported.mock.calls[0]![0]).toContain("AGENT_APPROVAL_TIMEOUT_SETTLEMENT_FAILED");
    reported.mockRestore();
  });

  it("cancels every expired request of one parked session in a single response", async () => {
    const { respond, values } = dependencies();
    values.repository.claimExpired.mockResolvedValue([
      claim({ id: "approval-1", requestId: "aitxt-1", toolName: "manage_family_invitation" }),
      claim({ id: "approval-2", requestId: "aitxt-2", toolName: "manage_family_invitation" }),
      claim({ id: "approval-3", requestId: "aitxt-3", telegramMessageId: "2802" }),
    ]);

    const resolved = await createApprovalTimeoutResolver(values as never)(NOW);

    // Eve 0.40.0 merges answers only within one delivery; three deliveries would leave it parked.
    expect(resolved).toBe(3);
    expect(respond).toHaveBeenCalledTimes(1);
    const [inputResponses, options] = respond.mock.calls[0]!;
    expect(inputResponses).toEqual([
      { optionId: "cancel", requestId: "aitxt-1" },
      { optionId: "cancel", requestId: "aitxt-2" },
      { optionId: "cancel", requestId: "aitxt-3" },
    ]);
    expect((options as { context: string[] }).context).toHaveLength(3);
    expect(values.repository.completeTimeout).toHaveBeenCalledTimes(3);
    // Requests sharing one Telegram prompt rewrite it once; the other prompt is rewritten on its own.
    expect(values.finalizePrompt).toHaveBeenCalledTimes(2);
  });

  it("keeps sweeping the batch when releasing a lease fails", async () => {
    const { respond, values } = dependencies();
    const reported = vi.spyOn(console, "error").mockImplementation(() => {});
    values.repository.claimExpired.mockResolvedValue([
      claim({ eveSessionId: "wrun_parked_1", id: "approval-1", requestId: "aitxt-1" }),
      claim({ eveSessionId: "wrun_parked_2", id: "approval-2", requestId: "aitxt-2" }),
    ]);
    respond
      .mockRejectedValueOnce(new Error("first fails"))
      .mockResolvedValue({ sessionId: "wrun_parked", status: "accepted" });
    values.repository.failTimeout.mockRejectedValue(new Error("connection terminated"));

    const resolved = await createApprovalTimeoutResolver(values as never)(NOW);

    // The lease expires on its own; the remaining leased claims must still be processed.
    expect(resolved).toBe(1);
    expect(values.repository.completeTimeout).toHaveBeenCalledTimes(1);
    expect(reported.mock.calls.some(([line]) =>
      String(line).includes("AGENT_APPROVAL_TIMEOUT_LEASE_RELEASE_FAILED"))).toBe(true);
    reported.mockRestore();
  });

  it("keeps sweeping the batch when one Eve response fails", async () => {
    const { respond, values } = dependencies();
    values.repository.claimExpired.mockResolvedValue([
      claim({ eveSessionId: "wrun_parked_1", id: "approval-1", requestId: "aitxt-1" }),
      claim({ eveSessionId: "wrun_parked_2", id: "approval-2", requestId: "aitxt-2" }),
    ]);
    respond
      .mockRejectedValueOnce(new Error("first fails"))
      .mockResolvedValue({ sessionId: "wrun_parked", status: "accepted" });

    const resolved = await createApprovalTimeoutResolver(values as never)(NOW);

    expect(resolved).toBe(1);
    expect(values.repository.failTimeout).toHaveBeenCalledTimes(1);
    expect(values.repository.completeTimeout).toHaveBeenCalledTimes(1);
  });
});
