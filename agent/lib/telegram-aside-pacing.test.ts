/**
 * Telegram aside pacing tests.
 *
 * Constructs covered:
 * - `asidePauseMilliseconds`: typing pause grows with the aside length.
 * - The pause never outlives one Telegram typing indicator.
 */
import { describe, expect, it } from "vitest";

import {
  asidePauseMilliseconds,
  TELEGRAM_ASIDE_PAUSE_MAX_MILLISECONDS,
} from "./telegram-aside-pacing.js";

describe("asidePauseMilliseconds", () => {
  it("scales the pause with the visible length of a short aside", () => {
    expect(asidePauseMilliseconds("вывод")).toBe(1650);
  });

  it("caps the pause so one typing indicator covers it", () => {
    expect(asidePauseMilliseconds("а".repeat(200))).toBe(TELEGRAM_ASIDE_PAUSE_MAX_MILLISECONDS);
  });

  it("counts visible characters rather than UTF-16 units", () => {
    expect(asidePauseMilliseconds("👀👀")).toBe(asidePauseMilliseconds("ab"));
  });
});
