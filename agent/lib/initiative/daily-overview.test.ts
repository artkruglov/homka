/**
 * Обзор дня.
 *
 * Проверяется: пустой день молчит; просроченное идёт первым; длинный список не перечисляется
 * целиком; у каждой строки есть метка источника.
 */
import { describe, expect, it } from "vitest";

import { formatDailyOverview, type DailyOverview } from "./daily-overview.js";

const empty: DailyOverview = { overdue: [], promised: [], today: [] };

describe("formatDailyOverview", () => {
  it("says nothing at all when there is nothing to say", () => {
    // Сообщение без содержания хуже его отсутствия: следующее, в котором есть дело, тоже пропустят.
    expect(formatDailyOverview(empty)).toBeNull();
  });

  it("puts the overdue first and names the source of every line", () => {
    const text = formatDailyOverview({
      ...empty,
      overdue: [{ source: "Семья", title: "Оплатить счёт" }],
      today: [{ source: "Хозяйство", title: "Полить цветы" }],
    })!;
    expect(text.indexOf("Просрочено:")).toBeLessThan(text.indexOf("Сегодня:"));
    expect(text).toContain("• Оплатить счёт — Семья");
    expect(text).toContain("• Полить цветы — Хозяйство");
  });

  it("does not read out a long list", () => {
    const text = formatDailyOverview({
      ...empty,
      today: Array.from({ length: 9 }, (_, index) => ({ source: "Семья", title: `Дело ${index}` })),
    })!;
    expect(text).toContain("…и ещё 4");
    expect(text).not.toContain("Дело 5");
  });

  it("names what other people are waiting for", () => {
    expect(formatDailyOverview({ ...empty, promised: [{ source: "Семья", title: "Забрать посылку" }] }))
      .toContain("От вас ждут:\n• Забрать посылку — Семья");
  });
  it("includes unanswered requests even when there are no tasks today",()=>{
    expect(formatDailyOverview({...empty,waiting:[{source:"Семья",title:"Выбрать день"}]}))
      .toContain("Жду ответа:\n• Выбрать день — Семья");
  });
});
