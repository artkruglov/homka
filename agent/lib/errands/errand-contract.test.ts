/** An errand is an authorized delivery, not an implicit family obligation. */
import { describe, expect, it } from "vitest";
import { errandInput, errandToolInput, nextErrandState } from "./errand-contract.js";

describe("family errand contract", () => {
  it("leaves a prepared draft unsent until the initiator asks to send", () => {
    expect(nextErrandState("preparing", "result", false)).toBe("ready");
    expect(nextErrandState("ready", "send", false)).toBe("queued");
    expect(nextErrandState("preparing", "result", true)).toBe("queued");
    expect(() => nextErrandState("preparing", "send", false)).toThrow(/AGENT_ERRAND_TRANSITION_DENIED/u);
  });

  it("lets cancellation beat a late research result or delayed delivery", () => {
    for (const state of ["preparing", "ready", "queued"] as const) {
      expect(nextErrandState(state, "cancel", true)).toBe("cancelled");
    }
    for (const action of ["result", "send", "start_delivery"] as const) {
      expect(() => nextErrandState("cancelled", action, true)).toThrow(/AGENT_ERRAND_TRANSITION_DENIED/u);
    }
  });

  it("never turns an ambiguous send into a retry or an alleged cancellation", () => {
    expect(nextErrandState("queued", "start_delivery", true)).toBe("sending");
    expect(nextErrandState("sending", "ambiguous", true)).toBe("ambiguous");
    for (const state of ["sending", "sent", "ambiguous"] as const) {
      for (const action of ["send", "result", "cancel", "start_delivery"] as const) {
        expect(() => nextErrandState(state, action, true)).toThrow(/AGENT_ERRAND_TRANSITION_DENIED/u);
      }
    }
  });

  it("keeps a detailed internal result without broadening recipient-authored answers", () => {
    const text = "а".repeat(5000);
    const id = "f9630612-a105-43e1-99a2-f8f330bdf621";
    expect(errandInput.safeParse({ action: "result", id, version: 1, text, sources: [] }).success).toBe(true);
    expect(errandInput.safeParse({ action: "share_answer", id, resultVersion: 1, text }).success).toBe(false);
    expect(errandToolInput.safeParse({ action: "share_answer", id, resultVersion: 1, text }).success).toBe(false);
    expect(errandInput.safeParse({ action: "result", id, version: 1, text: "а".repeat(32001), sources: [] }).success).toBe(false);
  });

  it("rejects recipient changes and raw delivery routes in result input", () => {
    const result = { action: "result", id: "f9630612-a105-43e1-99a2-f8f330bdf621",
      version: 1, text: "Три прогулки рядом", sources: [] };
    expect(errandInput.safeParse(result).success).toBe(true);
    for (const extra of [{ recipientRef: result.id }, { chatId: "123" }, { mode: "send" }]) {
      expect(errandInput.safeParse({ ...result, ...extra }).success).toBe(false);
    }
    expect(errandInput.safeParse({ ...result, sources: [{ url: "file:///private/notes", checkedAt: "2026-09-12T12:00:00Z" }] }).success).toBe(false);
  });
});
