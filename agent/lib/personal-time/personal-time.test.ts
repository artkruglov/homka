/**
 * Личное время.
 *
 * Проверяется: день недели и часы берутся в поясе человека; окно каждого дня работает без дня
 * недели; конец окна уже свободен; название возвращается, чтобы отказ был понятен.
 */
import { describe, expect, it } from "vitest";

import { isWithinPersonalTime, personalTimeClause } from "./personal-time.js";

const gym = { endsAt: "21:00", startsAt: "19:00", title: "Зал", weekday: 2 };
const evening = { endsAt: "22:00", startsAt: "21:00", title: "Вечер с сыном", weekday: null };

describe("isWithinPersonalTime", () => {
  it("reads the weekday and the hour in the timezone of the person", () => {
    // Вторник 19:30 в Москве это вторник 16:30 по UTC: по UTC день и час другие.
    expect(isWithinPersonalTime([gym], new Date("2026-09-15T16:30:00.000Z"), "Europe/Moscow"))
      .toBe("Зал");
    expect(isWithinPersonalTime([gym], new Date("2026-09-15T16:30:00.000Z"), "UTC")).toBeNull();
  });

  it("keeps a window without a weekday every day", () => {
    expect(isWithinPersonalTime([evening], new Date("2026-09-13T21:30:00.000Z"), "UTC"))
      .toBe("Вечер с сыном");
    expect(isWithinPersonalTime([evening], new Date("2026-09-16T21:30:00.000Z"), "UTC"))
      .toBe("Вечер с сыном");
  });

  it("frees the person at the end of the window", () => {
    expect(isWithinPersonalTime([evening], new Date("2026-09-13T22:00:00.000Z"), "UTC")).toBeNull();
    expect(isWithinPersonalTime([evening], new Date("2026-09-13T20:59:00.000Z"), "UTC")).toBeNull();
  });

  it("refuses a parameter or an alias that is not its own SQL", () => {
    expect(() => personalTimeClause({ alias: "slot", at: "now()", timezone: "settings.timezone" }))
      .toThrow(/PARAMETER_INVALID/u);
    expect(() => personalTimeClause({ alias: "slot; DROP", at: "$1", timezone: "settings.timezone" }))
      .toThrow(/ALIAS_INVALID/u);
    expect(() => personalTimeClause({ alias: "slot", at: "$1", timezone: "'; DROP" }))
      .toThrow(/TIMEZONE_INVALID/u);
  });
});
