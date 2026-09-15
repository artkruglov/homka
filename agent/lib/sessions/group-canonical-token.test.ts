/**
 * Canonical Telegram group continuation-token tests.
 *
 * Constructs covered:
 * - `groupCanonicalContinuationToken`: stable identity by persisted group and verified topic only.
 * - Main-topic and forum-topic isolation with fail-fast topic validation.
 */
import { describe, expect, it } from "vitest";

import { groupCanonicalContinuationToken } from "./group-canonical-token.js";

describe("groupCanonicalContinuationToken", () => {
  it("reuses one token for every ordinary turn in the same group topic", () => {
    expect(groupCanonicalContinuationToken("group-1", null)).toBe(
      groupCanonicalContinuationToken("group-1", null),
    );
    expect(groupCanonicalContinuationToken("group-1", 55)).toBe(
      groupCanonicalContinuationToken("group-1", 55),
    );
  });

  it("isolates the main topic and each verified forum topic", () => {
    const tokens = new Set([
      groupCanonicalContinuationToken("group-1", null),
      groupCanonicalContinuationToken("group-1", 55),
      groupCanonicalContinuationToken("group-1", 56),
      groupCanonicalContinuationToken("group-2", 55),
    ]);

    expect(tokens.size).toBe(4);
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects an unverified topic value %s", (topicId) => {
    expect(() => groupCanonicalContinuationToken("group-1", topicId)).toThrowError(
      /AGENT_TELEGRAM_TOPIC_INVALID/u,
    );
  });
});
