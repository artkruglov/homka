import { describe, expect, it, vi } from "vitest";
import { paceDeltaSink } from "./delta-pacing.ts";
import { emitStreamContent } from "../../node_modules/eve/dist/src/harness/emission.js";

describe("durable delta coalescing", () => {
  it("retains all text, cumulative snapshots and barriers with bounded persistence frequency", async () => {
    vi.useFakeTimers();
    const sink = vi.fn(async (_event: unknown) => {});
    const run = () => emitStreamContent(sink as never,
      { sequence: 1, stepIndex: 0, turnId: "turn_1", sessionStarted: true },
      new ReadableStream({ start(controller) {
        for (let i = 0; i < 500; i++) controller.enqueue({ type: "reasoning-delta", text: "x" });
        controller.enqueue({ type: "finish-step", finishReason: "stop" }); controller.close();
      } }) as never);
    try {
      const pending = run(); await vi.runAllTimersAsync(); await pending;
      const events = sink.mock.calls.map(([e]) => e as { type: string; data: { reasoningDelta?: string; reasoningSoFar?: string } });
      const deltas = events.filter(e => e.type === "reasoning.appended");
      expect(deltas.length).toBeLessThan(20);
      expect(deltas.map(e => e.data.reasoningDelta).join("")).toBe("x".repeat(500));
      expect(deltas.at(-1)?.data.reasoningSoFar).toBe("x".repeat(500));
      expect(events.at(-1)?.type).toBe("reasoning.completed");
    } finally { vi.useRealTimers(); }
  });

  it("does not delay non-delta events and propagates persistence failure", async () => {
    const error = new Error("persistence failed"); const sink = vi.fn().mockRejectedValue(error);
    await expect(paceDeltaSink(sink)({ type: "session.failed" })).rejects.toBe(error);
    expect(sink).toHaveBeenCalledOnce();
  });
});
