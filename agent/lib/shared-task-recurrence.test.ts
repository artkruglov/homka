/**
 * Пропуски не проигрываются, а календарное правило не сползает от пропущенного вхождения:
 * следующая пятница считается от исходного якоря, а не от прошлой даты.
 */
import { describe, expect, it } from "vitest";

import { nextOccurrenceOn } from "./shared-task-recurrence.js";

describe("task recurrence", () => {
  it("moves to the next future occurrence of the calendar rule", () => {
    expect(nextOccurrenceOn({
      anchorOn: "2026-09-04", interval: 1, occurrenceIndex: 0, today: "2026-09-04", unit: "weekly",
    })).toEqual({ occurrenceIndex: 1, on: "2026-09-11" });
  });

  it("skips a month of missed occurrences instead of replaying them", () => {
    // Дело не закрывали пять недель: следующей становится ближайшая будущая пятница.
    expect(nextOccurrenceOn({
      anchorOn: "2026-09-04", interval: 1, occurrenceIndex: 0, today: "2026-10-08", unit: "weekly",
    })).toEqual({ occurrenceIndex: 5, on: "2026-10-09" });
  });

  it("clamps a monthly rule to a short month instead of sliding into the next one", () => {
    // «Каждое 31-е» в феврале это 28-е: иначе дело уезжает в март и пропускает свой месяц.
    expect(nextOccurrenceOn({
      anchorOn: "2026-01-31", interval: 1, occurrenceIndex: 0, today: "2026-02-01", unit: "monthly",
    }).on).toBe("2026-02-28");
    expect(nextOccurrenceOn({
      anchorOn: "2026-01-31", interval: 2, occurrenceIndex: 0, today: "2026-02-01", unit: "monthly",
    }).on).toBe("2026-03-31");
  });

  it("comes back to a daily task abandoned for years instead of refusing to close it", () => {
    // Потолок в тысячу шагов у ежедневного правила это меньше трёх лет. Человек, вернувшийся к
    // заброшенному делу, получал отказ и не мог закрыть его никогда.
    expect(nextOccurrenceOn({
      anchorOn: "2020-01-01", interval: 1, occurrenceIndex: 0, today: "2026-09-12", unit: "daily",
    })).toEqual({ occurrenceIndex: 2447, on: "2026-09-13" });
    expect(nextOccurrenceOn({
      anchorOn: "2016-03-05", interval: 1, occurrenceIndex: 0, today: "2026-09-12", unit: "monthly",
    }).on).toBe("2026-10-05");
  });

  it("counts from the completion itself when the rule says so", () => {
    expect(nextOccurrenceOn({
      anchorOn: "2026-01-01", interval: 30, occurrenceIndex: 3, today: "2026-09-12",
      unit: "after_completion",
    })).toEqual({ occurrenceIndex: 4, on: "2026-10-12" });
  });
});
