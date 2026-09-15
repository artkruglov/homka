/**
 * Exact-duplicate normalization tests.
 *
 * Constructs covered:
 * - Case, width and punctuation differences still collapse.
 * - A sign before a number and a percent sign survive: "-18 °C" is not "18 °C".
 */
import { describe, expect, it } from "vitest";

import { normalizeMemoryClaimContent } from "./memory-record.js";

describe("normalizeMemoryClaimContent", () => {
  it("collapses case, width and punctuation", () => {
    expect(normalizeMemoryClaimContent(" ВРАЧ рекомендует пить воду утром!!! "))
      .toBe(normalizeMemoryClaimContent("врач рекомендует пить воду утром"));
  });

  it("keeps the sign of a number and a percent", () => {
    expect(normalizeMemoryClaimContent("Хранить при -18 °C")).not.toBe(normalizeMemoryClaimContent("Хранить при 18 °C"));
    expect(normalizeMemoryClaimContent("Скидка 50%")).not.toBe(normalizeMemoryClaimContent("Скидка 50"));
    expect(normalizeMemoryClaimContent("Хранить при -18 °C")).toBe(normalizeMemoryClaimContent("хранить при −18°C"));
  });
});
