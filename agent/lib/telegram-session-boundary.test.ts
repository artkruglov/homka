/**
 * Bounded observation of an Eve session stream.
 *
 * Constructs covered:
 * - A stream that never reports a boundary rejects after the idle window and is cancelled.
 * - Every event of the current turn extends the idle window, so a long active turn completes.
 * - A stream that closes without a boundary keeps the dedicated missing-boundary code.
 * - A boundary already observed survives a failing reader cancellation.
 */
import { describe, expect, it, vi } from "vitest";

import { waitForSessionBoundary } from "./telegram-session-boundary.js";

describe("waitForSessionBoundary", () => {
  it("rejects a silent stream after the idle window and cancels its reader", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const stream = new ReadableStream<{ type: string }>({ cancel });
    try {
      const pending = waitForSessionBoundary(
        { getEventStream: async () => stream, id: "silent" },
        0,
        { idleMilliseconds: 30, updateId: "1" },
      ).then((value) => value, (error: unknown) => error);
      await vi.advanceTimersByTimeAsync(31);

      await expect(pending).resolves.toMatchObject({ code: "AGENT_TELEGRAM_SESSION_BOUNDARY_TIMEOUT" });
      expect(cancel).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles the timeout even when a stuck stream never finishes opening", async () => {
    vi.useFakeTimers();
    try {
      const pending = waitForSessionBoundary(
        { getEventStream: () => new Promise(() => {}), id: "unopened" },
        0,
        { idleMilliseconds: 30, updateId: "1" },
      ).then((value) => value, (error: unknown) => error);
      await vi.advanceTimersByTimeAsync(31);

      await expect(pending).resolves.toMatchObject({ code: "AGENT_TELEGRAM_SESSION_BOUNDARY_TIMEOUT" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("extends the idle window while the current turn keeps producing events", async () => {
    vi.useFakeTimers();
    let controller!: ReadableStreamDefaultController<{ type: string }>;
    try {
      const pending = waitForSessionBoundary(
        { getEventStream: async () => new ReadableStream({ start(c) { controller = c; } }), id: "active" },
        0,
        { idleMilliseconds: 30, updateId: "1" },
      ).then((value) => value, (error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      for (let index = 0; index < 10; index += 1) {
        controller.enqueue({ type: "message.appended" });
        await vi.advanceTimersByTimeAsync(25);
      }
      controller.enqueue({ type: "session.waiting" });

      await expect(pending).resolves.toBe(11);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a closed stream without a boundary with the missing-boundary code", async () => {
    await expect(waitForSessionBoundary(
      { getEventStream: async () => new ReadableStream({ start(c) { c.close(); } }), id: "closed" },
      0,
      { idleMilliseconds: 1_000, updateId: "1" },
    )).rejects.toMatchObject({ code: "AGENT_TELEGRAM_SESSION_BOUNDARY_MISSING" });
  });

  it("keeps an observed boundary when cancelling the reader fails", async () => {
    const stream = new ReadableStream<{ type: string }>({
      cancel() { throw new Error("cancel failed"); },
      start(c) { c.enqueue({ type: "session.waiting" }); },
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(waitForSessionBoundary(
        { getEventStream: async () => stream, id: "done" },
        4,
        { idleMilliseconds: 1_000, updateId: "1" },
      )).resolves.toBe(5);
    } finally {
      logged.mockRestore();
    }
  });
});
