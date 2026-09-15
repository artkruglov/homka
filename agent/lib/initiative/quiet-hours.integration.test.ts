/**
 * Проверка в процессе и проверка в SQL обязаны отвечать одинаково: расходись они, сводка
 * владельцу молчала бы ночью, а предупреждение памяти в ту же ночь приходило.
 */
import { afterAll, describe, expect, it } from "vitest";

import { database } from "../database.js";
import { isWithinQuietHours, quietHoursClause, type QuietHours } from "./quiet-hours.js";

const CASES: ReadonlyArray<{ at: string; expected: boolean; settings: QuietHours }> = [
  { at: "2026-09-12T20:30:00Z", expected: true,
    settings: { quietEnd: "08:00", quietStart: "22:00", timezone: "Europe/Moscow" } },
  { at: "2026-09-12T18:30:00Z", expected: false,
    settings: { quietEnd: "08:00", quietStart: "22:00", timezone: "Europe/Moscow" } },
  { at: "2026-09-12T04:59:00Z", expected: true,
    settings: { quietEnd: "08:00", quietStart: "22:00", timezone: "Europe/Moscow" } },
  { at: "2026-09-12T05:00:00Z", expected: false,
    settings: { quietEnd: "08:00", quietStart: "22:00", timezone: "Europe/Moscow" } },
  // Дневное окно не переходит через полночь и ведёт себя как обычный отрезок.
  { at: "2026-09-12T11:00:00Z", expected: true,
    settings: { quietEnd: "16:00", quietStart: "10:00", timezone: "UTC" } },
  { at: "2026-09-12T16:00:00Z", expected: false,
    settings: { quietEnd: "16:00", quietStart: "10:00", timezone: "UTC" } },
  // Полночь в поясе человека: граница окна, а не «24:00».
  { at: "2026-09-12T21:00:00Z", expected: true,
    settings: { quietEnd: "06:00", quietStart: "00:00", timezone: "Europe/Moscow" } },
  { at: "2026-09-12T20:59:00Z", expected: false,
    settings: { quietEnd: "06:00", quietStart: "00:00", timezone: "Europe/Moscow" } },
  { at: "2026-09-12T23:00:00Z", expected: false,
    settings: { quietEnd: null, quietStart: null, timezone: "Europe/Moscow" } },
  // Переход на зимнее время в чужом поясе: тот же час UTC по разные стороны перевода.
  { at: "2026-10-26T00:30:00Z", expected: true,
    settings: { quietEnd: "02:00", quietStart: "23:00", timezone: "Europe/Berlin" } },
  { at: "2026-10-24T00:30:00Z", expected: false,
    settings: { quietEnd: "02:00", quietStart: "23:00", timezone: "Europe/Berlin" } },
];

describe.runIf(process.env.RUN_DATABASE_INTEGRATION_TESTS === "true")("quiet hours", () => {
  afterAll(async () => { await database().end(); });

  it("answers the same in the process and in SQL", async () => {
    for (const testCase of CASES) {
      const at = new Date(testCase.at);
      expect({ ...testCase, actual: isWithinQuietHours(testCase.settings, at) })
        .toMatchObject({ actual: testCase.expected });
      const { rows } = await database().query<{ quiet: boolean }>(
        `SELECT ${quietHoursClause({ alias: "settings", now: "$4" })} AS quiet
           FROM (SELECT $1::text AS timezone, $2::time AS quiet_start, $3::time AS quiet_end)
             AS settings`,
        [testCase.settings.timezone, testCase.settings.quietStart, testCase.settings.quietEnd, at],
      );
      expect({ ...testCase, sql: rows[0]!.quiet }).toMatchObject({ sql: testCase.expected });
    }
  });

  it("refuses a parameter or an alias that is not its own SQL", () => {
    expect(() => quietHoursClause({ alias: "settings", now: "now()" })).toThrow(/PARAMETER_INVALID/u);
    expect(() => quietHoursClause({ alias: "settings; DROP", now: "$1" })).toThrow(/ALIAS_INVALID/u);
  });
});
