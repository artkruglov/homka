/**
 * Правило инициативы.
 *
 * Проверяется: выключатель сильнее любой срочности; тихие часы откладывают; молчание человека
 * само по себе останавливает следующие попытки; предел считается сутками человека.
 */
import { describe, expect, it } from "vitest";

import {
  decideInitiative,
  INITIATIVE_UNANSWERED_LIMIT,
  type InitiativeSettings,
} from "./initiative-policy.js";

const settings: InitiativeSettings = {
  dailyLimit: 3, enabled: true, quietEnd: "08:00", quietStart: "22:00", timezone: "Europe/Moscow",
};
const noon = new Date("2026-09-12T09:00:00.000Z");

describe("decideInitiative", () => {
  it("allows a first message of the day outside the quiet hours", () => {
    expect(decideInitiative(settings, { sentToday: 0, unanswered: 0 }, noon))
      .toEqual({ allowed: true });
  });

  it("says nothing at all when the person asked not to be written to first", () => {
    expect(decideInitiative({ ...settings, enabled: false }, { sentToday: 0, unanswered: 0 }, noon))
      .toEqual({ allowed: false, reason: "muted" });
    // Ноль в сутки это тот же выключатель, выраженный числом.
    expect(decideInitiative({ ...settings, dailyLimit: 0 }, { sentToday: 0, unanswered: 0 }, noon))
      .toEqual({ allowed: false, reason: "daily_limit" });
  });

  it("waits out the quiet hours before anything else it could say", () => {
    expect(decideInitiative(settings, { sentToday: 0, unanswered: 0 },
      new Date("2026-09-12T20:30:00.000Z")))
      .toEqual({ allowed: false, reason: "quiet_hours" });
  });

  it("stops after the person has answered none of them", () => {
    // Молчание и есть ответ: продолжать значит превращать помощь в рассылку.
    expect(decideInitiative(settings, { sentToday: 0, unanswered: INITIATIVE_UNANSWERED_LIMIT }, noon))
      .toEqual({ allowed: false, reason: "unanswered" });
    expect(decideInitiative(settings, { sentToday: 0, unanswered: INITIATIVE_UNANSWERED_LIMIT - 1 }, noon))
      .toEqual({ allowed: true });
  });

  it("keeps the day's limit even when everything else allows it", () => {
    expect(decideInitiative(settings, { sentToday: 3, unanswered: 0 }, noon))
      .toEqual({ allowed: false, reason: "daily_limit" });
  });
});
