/**
 * Обзор дня.
 *
 * Проверяется: пустой день молчит; просроченное идёт первым; все открытые дела видны по спискам,
 * длинный список сокращается до первых пунктов и числа, а не прячется.
 */
import { describe, expect, it } from "vitest";

import type { BoardTask } from "../task-board.js";
import { formatDailyOverview, type DailyOverview } from "./daily-overview.js";

const NOW = new Date("2026-09-22T06:00:00Z");
const task = (title: string, extra: Partial<BoardTask> = {}): BoardTask => ({
  dueAt: null, dueOn: null, kind: "task", listName: null, source: "Личное", status: "accepted", title, ...extra,
});
const empty: DailyOverview = { now: NOW, tasks: [], timezone: "Europe/Moscow", waiting: [] };

describe("formatDailyOverview", () => {
  it("says nothing at all when there is nothing to say", () => {
    expect(formatDailyOverview(empty)).toBeNull();
  });

  it("shows the whole open list, overdue first, not only what is due today", () => {
    const text = formatDailyOverview({
      ...empty,
      tasks: [
        task("Договориться с мастером", { dueOn: "2026-09-15", listName: "Встречи" }),
        task("Продвинуться по продаже", { listName: "Работа" }),
        task("Отвезти машину", { listName: "Дом" }),
      ],
    })!;
    expect(text.startsWith("Доброе утро. Вот твои дела.")).toBe(true);
    expect(text.indexOf("⚠️ Просрочено · 1")).toBeLessThan(text.indexOf("Работа · 1"));
    expect(text).toContain("• Продвинуться по продаже");
    expect(text).toContain("• Отвезти машину");
    expect(text).toContain("Открытых дел: 3");
  });

  it("includes unanswered requests even when there are no tasks", () => {
    expect(formatDailyOverview({ ...empty, waiting: [task("Выбрать день", { status: "proposed" })] }))
      .toContain("Жду ответа · 1\n• Выбрать день · ждёт согласия");
  });

  it("explains itself the first time", () => {
    expect(formatDailyOverview({ ...empty, tasks: [task("Дело")] }, { first: true }))
      .toContain("Это утренний обзор");
  });
});
