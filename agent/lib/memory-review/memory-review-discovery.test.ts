/**
 * Eve discovery contract for the silent memory-review runtime.
 *
 * Construct covered:
 * - The authored receive channel owns a fail-closed route required by Eve 0.32 discovery.
 * - The minute schedule targets that channel while the sole application tool remains dynamic.
 */
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("memory review Eve discovery", () => {
  it("keeps the receive channel discoverable and the tool surface in one dynamic module", async () => {
    const [channel, schedule, tools] = await Promise.all([
      readFile(new URL("../../channels/memory-review.ts", import.meta.url), "utf8"),
      readFile(new URL("../../schedules/memory-review-dispatch.ts", import.meta.url), "utf8"),
      readFile(new URL("../../tools/capabilities.ts", import.meta.url), "utf8"),
    ]);

    expect(channel).toContain('POST("/internal/memory-review"');
    expect(channel).toContain("status: 404");
    expect(channel).toContain("receive(input, { from })");
    expect(schedule).toContain("dispatchPendingMemoryReviews(to)");
    expect(tools).toContain("buildMemoryReviewToolSurface");
  });
});
