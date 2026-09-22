/** Коуч пишет только по поводу, только после согласия и никогда о делах, сроках или счёте. */
import { describe, expect, it } from "vitest";

import { chooseCoachTouch, COACH_INVITE_TEXT, type CoachFacts } from "./coach.js";

const NOW = new Date("2026-09-25T15:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
const facts = (extra: Partial<CoachFacts> = {}): CoachFacts => ({
  enabled: true, familyRituals: 1, invited: true, lastByReason: {}, lastTouchAt: null,
  openDecision: null, personalWindows: 1, quietRitual: null, touchesLastWeek: 0, ...extra,
});
const afternoon = { hour: 15, weekday: 3 };

describe("coach touch", () => {
  it("invites once and asks nothing until the person says yes", () => {
    expect(chooseCoachTouch(facts({ enabled: null, invited: false }), afternoon, NOW))
      .toEqual({ reason: "invite", subject: null, text: COACH_INVITE_TEXT });
    expect(chooseCoachTouch(facts({ enabled: null, invited: true, personalWindows: 0 }), afternoon, NOW)).toBeNull();
    expect(chooseCoachTouch(facts({ enabled: false, personalWindows: 0 }), afternoon, NOW)).toBeNull();
    expect(COACH_INVITE_TEXT).toContain("Без коуча");
  });

  it("stays silent without a reason: the ceiling is not a schedule", () => {
    expect(chooseCoachTouch(facts(), afternoon, NOW)).toBeNull();
  });

  it("keeps two days between touches and three a week", () => {
    const due = facts({ personalWindows: 0 });
    expect(chooseCoachTouch({ ...due, lastTouchAt: ago(1) }, afternoon, NOW)).toBeNull();
    expect(chooseCoachTouch({ ...due, touchesLastWeek: 3, lastTouchAt: ago(2) }, afternoon, NOW)).toBeNull();
    expect(chooseCoachTouch({ ...due, lastTouchAt: ago(2) }, afternoon, NOW)?.reason).toBe("rest_window_missing");
  });

  it("writes neither early in the morning nor at night", () => {
    const due = facts({ enabled: null, invited: false });
    expect(chooseCoachTouch(due, { hour: 9, weekday: 3 }, NOW)).toBeNull();
    expect(chooseCoachTouch(due, { hour: 21, weekday: 3 }, NOW)).toBeNull();
  });

  it("asks about the partner's proposal first and says silence is not consent", () => {
    const touch = chooseCoachTouch(facts({
      openDecision: { id: "d1", proposer: "Саша", title: "Чай без телефонов по воскресеньям" },
      personalWindows: 0, quietRitual: { id: "r1", title: "Прогулка" },
    }), afternoon, NOW)!;

    expect(touch).toMatchObject({ reason: "decision_open", subject: "d1" });
    expect(touch.text).toContain("Саша предлагает: «Чай без телефонов по воскресеньям»");
    expect(touch.text).toContain("молчание я согласием не считаю");
  });

  it("offers to skip or drop a quiet tradition instead of counting misses", () => {
    const touch = chooseCoachTouch(facts({ quietRitual: { id: "r1", title: "Воскресный чай" } }), afternoon, NOW)!;

    expect(touch).toMatchObject({ reason: "ritual_checkin", subject: "r1" });
    expect(touch.text).toContain("пропустить или снять");
    expect(touch.text).not.toMatch(/\d/u);
  });

  it("asks what pleased on Friday or Sunday evening, once a week", () => {
    const friday = { hour: 19, weekday: 5 };
    expect(chooseCoachTouch(facts(), friday, NOW)?.reason).toBe("week_warm");
    expect(chooseCoachTouch(facts({ lastByReason: { week_warm: ago(2) } }), friday, NOW)).toBeNull();
    expect(chooseCoachTouch(facts(), { hour: 19, weekday: 3 }, NOW)).toBeNull();
  });

  it("asks about own time and a first tradition at most every two weeks", () => {
    expect(chooseCoachTouch(facts({ personalWindows: 0, lastByReason: { rest_window_missing: ago(13) } }), afternoon, NOW))
      .toBeNull();
    expect(chooseCoachTouch(facts({ familyRituals: 0 }), afternoon, NOW)?.reason).toBe("ritual_none");
    expect(chooseCoachTouch(facts({ familyRituals: 0, lastByReason: { ritual_none: ago(3) } }), afternoon, NOW))
      .toBeNull();
  });

  it("never talks about tasks, deadlines or counts", () => {
    const texts = [
      chooseCoachTouch(facts({ personalWindows: 0 }), afternoon, NOW)!.text,
      chooseCoachTouch(facts({ familyRituals: 0 }), afternoon, NOW)!.text,
      chooseCoachTouch(facts(), { hour: 19, weekday: 0 }, NOW)!.text,
    ];
    for (const text of texts) expect(text).not.toMatch(/(^|\s)(дело|дела|дел)([\s,.?!]|$)|срок|просроч|\d/iu);
  });
});
