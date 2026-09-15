/**
 * Session rotation policy tests.
 *
 * Constructs covered:
 * - `continuationTokenForGeneration`: generation-zero compatibility and isolated successors.
 * - `sessionNeedsRotation`: inactivity, replay-safe turn-limit, manual, and pending-operation rules.
 */
import { describe, expect, it } from "vitest";

import {
  continuationTokenForGeneration,
  sessionNeedsRotation,
} from "./session-policy.js";

const NOW = new Date("2026-07-12T12:00:00.000Z");
const family = { kind: "canonical" as const, scope: "family" as const };
const privateChat = { kind: "canonical" as const, scope: "personal" as const };

describe("session rotation policy", () => {
  it("keeps the existing Eve continuation token for generation zero", () => {
    expect(continuationTokenForGeneration("101::", 0)).toBe("101::");
    expect(continuationTokenForGeneration("101::", 1)).toBe("101:::osinara:1");
  });

  it("rotates after inactivity or before the Eve workflow journal becomes replay-unsafe", () => {
    expect(sessionNeedsRotation({
      completedTurns: 1,
      lastActivityAt: new Date("2026-06-12T11:59:59.999Z"),
      now: NOW,
      pendingOperation: false,
      rotationRequestedAt: null,
      ...family,
    })).toBe(true);
    expect(sessionNeedsRotation({
      completedTurns: 49,
      lastActivityAt: NOW,
      now: NOW,
      pendingOperation: false,
      rotationRequestedAt: null,
      ...family,
    })).toBe(false);
    expect(sessionNeedsRotation({
      completedTurns: 50,
      lastActivityAt: NOW,
      now: NOW,
      pendingOperation: false,
      rotationRequestedAt: null,
      ...family,
    })).toBe(true);
  });

  // 14 сентября 2026: личная сессия копила историю до 120 тыс. токенов, и утренний вопрос нёс
  // вчерашнюю переписку. Память, дела и последние сообщения таймлайна переходят в новую сессию,
  // а семья и группы держат живое обсуждение и остаются на прежнем сроке.
  it("starts a new private chat session after twelve quiet hours but keeps family and group sessions", () => {
    const state = (lastActivityAt: Date, scope: "family" | "group" | "personal", kind: "canonical" | "task" = "canonical") => ({
      completedTurns: 3, kind, lastActivityAt, now: NOW, pendingOperation: false, rotationRequestedAt: null, scope,
    });
    const almostTwelveHours = new Date(NOW.getTime() - 12 * 60 * 60 * 1_000 + 1);
    const twelveHours = new Date(NOW.getTime() - 12 * 60 * 60 * 1_000);
    expect(sessionNeedsRotation(state(almostTwelveHours, "personal"))).toBe(false);
    expect(sessionNeedsRotation(state(twelveHours, "personal"))).toBe(true);
    expect(sessionNeedsRotation(state(twelveHours, "family"))).toBe(false);
    expect(sessionNeedsRotation(state(twelveHours, "group"))).toBe(false);
    expect(sessionNeedsRotation(state(twelveHours, "personal", "task"))).toBe(false);
    expect(sessionNeedsRotation({ ...state(twelveHours, "personal"), pendingOperation: true })).toBe(false);
  });

  it("defers every rotation reason while a HITL or OAuth operation is pending", () => {
    expect(sessionNeedsRotation({
      completedTurns: 50,
      lastActivityAt: new Date("2026-01-01T00:00:00.000Z"),
      now: NOW,
      pendingOperation: true,
      rotationRequestedAt: NOW,
      ...privateChat,
    })).toBe(false);
  });

  it("honours an explicit new-context request before automatic thresholds", () => {
    expect(sessionNeedsRotation({
      completedTurns: 2,
      lastActivityAt: NOW,
      now: NOW,
      pendingOperation: false,
      rotationRequestedAt: NOW,
      ...family,
    })).toBe(true);
  });
});
