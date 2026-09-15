/**
 * Bounded warm sandbox cache tests.
 *
 * Constructs covered:
 * - Recent stopped containers remain reusable.
 * - The oldest stopped containers are removed when the hard cache bound is exceeded.
 */
import type Docker from "dockerode";
import { describe, expect, it, vi } from "vitest";

import { createSandboxActivityRegistry } from "./docker-sandbox-lifecycle.js";
import {
  reconcileSandboxContainers,
  SANDBOX_STOPPED_CACHE_MAX,
} from "./docker-sandbox-reconciliation.js";

const NOW_MS = Date.parse("2026-07-30T20:00:00.000Z");

describe("sandbox warm-cache reconciliation", () => {
  it("removes only the oldest recent containers above the hard cache bound", async () => {
    const count = SANDBOX_STOPPED_CACHE_MAX + 2;
    const removals = Array.from({ length: count }, () => vi.fn(async () => undefined));
    const listed = Array.from({ length: count }, (_, index) => ({
      Id: `container-${index}`,
      Labels: { "dev.osinara.sandbox.session-id": `session-${index}` },
      State: "exited",
    }));
    const docker = {
      getContainer: vi.fn((id: string) => {
        const index = Number(id.slice("container-".length));
        return {
          inspect: vi.fn(async () => ({
            State: {
              FinishedAt: new Date(NOW_MS - (count - index) * 60 * 60 * 1_000).toISOString(),
              Running: false,
            },
          })),
          remove: removals[index],
        };
      }),
      listContainers: vi.fn(async () => listed),
    } as unknown as Docker;

    await expect(reconcileSandboxContainers({
      activity: createSandboxActivityRegistry(() => NOW_MS),
      docker,
      idleCutoffMs: NOW_MS - 30 * 60 * 1_000,
      nowMs: NOW_MS,
      project: "osinara",
    })).resolves.toEqual({ removed: 2, stopped: 0 });

    expect(removals[0]).toHaveBeenCalledOnce();
    expect(removals[1]).toHaveBeenCalledOnce();
    expect(removals.slice(2).every((remove) => remove.mock.calls.length === 0)).toBe(true);
  });
});
