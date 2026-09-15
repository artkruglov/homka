/**
 * Graceful memory worker shutdown tests.
 *
 * Constructs covered:
 * - SIGTERM-style cancellation stops new claims but lets the current durable step settle.
 * - Readiness is published only after the first durable step completes successfully.
 * - Database cleanup runs exactly once after the active step finishes.
 */
import { describe, expect, it, vi } from "vitest";

import { runMemoryWorkerLoop } from "./memory-worker-loop.js";

describe("memory worker loop", () => {
  it("finishes the active step before closing on cancellation", async () => {
    const controller = new AbortController();
    let finishStep!: () => void;
    const processNext = vi.fn(() => new Promise<boolean>((resolve) => {
      finishStep = () => resolve(true);
    }));
    const close = vi.fn();
    const markReady = vi.fn();
    const running = runMemoryWorkerLoop({
      close,
      idleMilliseconds: 1,
      markReady,
      processNext,
      signal: controller.signal,
    });

    await vi.waitFor(() => expect(processNext).toHaveBeenCalledTimes(1));
    controller.abort();
    finishStep();
    await running;

    expect(processNext).toHaveBeenCalledTimes(1);
    expect(markReady).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("publishes readiness once after a successful durable step", async () => {
    const controller = new AbortController();
    const markReady = vi.fn(async () => controller.abort());

    await runMemoryWorkerLoop({
      close: vi.fn(),
      idleMilliseconds: 1,
      markReady,
      processNext: vi.fn().mockResolvedValue(false),
      signal: controller.signal,
    });

    expect(markReady).toHaveBeenCalledTimes(1);
  });

  it("does not publish readiness when the first durable step fails", async () => {
    const failure = new Error("catch-up failed");
    const close = vi.fn();
    const markReady = vi.fn();

    await expect(runMemoryWorkerLoop({
      close,
      idleMilliseconds: 1,
      markReady,
      processNext: vi.fn().mockRejectedValue(failure),
      signal: new AbortController().signal,
    })).rejects.toBe(failure);

    expect(markReady).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
