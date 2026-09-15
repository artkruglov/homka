/**
 * Batched approval prompt tests.
 *
 * Constructs covered:
 * - Only a step made of button-answered tool approvals is combined.
 * - The combined prompt numbers every member and relabels the shared buttons.
 */
import { describe, expect, it } from "vitest";

import { combineApprovalRequests, isBatchedApprovalStep } from "./approval-batch.js";

function request(index: number, overrides: Record<string, unknown> = {}) {
  return {
    kind: "tool-approval" as const,
    request: {
      action: {
        callId: `call-${index}`,
        input: { action: "approve", invitationId: `inv-${index}` },
        kind: "tool-call" as const,
        toolName: "manage_family_invitation",
      },
      display: "confirmation" as const,
      options: [
        { id: "approve", label: "Да, подтвердить" },
        { id: "cancel", label: "Нет, отменить" },
      ],
      prompt: `Подтвердите действие ${index}`,
      requestId: `aitxt-${index}`,
      ...overrides,
    },
  };
}

describe("isBatchedApprovalStep", () => {
  it("combines only a step of several button-answered approvals", () => {
    expect(isBatchedApprovalStep([request(1)])).toBe(false);
    expect(isBatchedApprovalStep([request(1), request(2), request(3)])).toBe(true);
    expect(isBatchedApprovalStep([
      request(1),
      { ...request(2), kind: "question" },
    ])).toBe(false);
    expect(isBatchedApprovalStep([
      request(1),
      request(2, { options: undefined }),
    ])).toBe(false);
    expect(isBatchedApprovalStep([
      request(1),
      request(2, { options: [{ id: "continue", label: "Продолжить" }] }),
    ])).toBe(false);
  });
});

describe("combineApprovalRequests", () => {
  it("numbers every member under one shared pair of buttons", () => {
    const combined = combineApprovalRequests([request(1), request(2), request(3)]);

    expect(combined.requestId).toBe("aitxt-1");
    expect(combined.action.callId).toBe("call-1");
    expect(combined.options).toEqual([
      { id: "approve", label: "Да, подтвердить все" },
      { id: "cancel", label: "Нет, отменить все" },
    ]);
    expect(combined.prompt).toBe([
      "Нужно подтвердить сразу 3 действия. Кнопка внизу отвечает за все.",
      "1. Подтвердите действие 1",
      "2. Подтвердите действие 2",
      "3. Подтвердите действие 3",
    ].join("\n\n"));
  });

  it("declines a step that is not a pure approval batch", () => {
    expect(() => combineApprovalRequests([request(1)])).toThrow("AGENT_APPROVAL_BATCH_INVALID");
  });
});
