/**
 * Turn timing log tests.
 *
 * Constructs covered:
 * - `timed` logs the stage duration and returns the stage result.
 * - A failing stage still logs and rethrows the original error.
 */
import { describe, expect, it, vi } from "vitest";

import { logTurnTiming, timed } from "./turn-timing.js";

describe("turn timing", () => {
  it("logs one AGENT_TURN_TIMING line with the stage, duration and detail", () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      logTurnTiming("turn_started", 12.6, { turnId: "turn_1" });
      expect(log).toHaveBeenCalledTimes(1);
      expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual({
        code: "AGENT_TURN_TIMING",
        ms: 13,
        stage: "turn_started",
        turnId: "turn_1",
      });
    } finally {
      log.mockRestore();
    }
  });

  it("returns the stage result and logs its duration", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      await expect(timed("tools_surface", async () => "surface")).resolves.toBe("surface");
      const entry = JSON.parse(log.mock.calls[0]![0] as string) as { ms: number; stage: string };
      expect(entry.stage).toBe("tools_surface");
      expect(entry.ms).toBeGreaterThanOrEqual(0);
    } finally {
      log.mockRestore();
    }
  });

  it("logs and rethrows when the stage fails", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      await expect(timed("instructions_mode", () => Promise.reject(new Error("boom"))))
        .rejects.toThrowError("boom");
      expect(log).toHaveBeenCalledTimes(1);
    } finally {
      log.mockRestore();
    }
  });
});
