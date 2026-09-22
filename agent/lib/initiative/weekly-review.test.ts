/** Недельный обзор молчит, когда пересматривать нечего, и никогда не советует и не считает вклад. */
import { describe, expect, it } from "vitest";

import type { BoardTask } from "../task-board.js";
import { formatWeeklyReview, WEEKLY_REVIEW_QUESTIONS, type WeeklyReviewInput } from "./weekly-review.js";

// Воскресенье 27 сентября 2026, 19:00 по Москве.
const NOW = new Date("2026-09-27T16:00:00Z");

function task(extra: Partial<BoardTask> = {}): BoardTask {
  return {
    dueAt: null, dueOn: null, kind: "task", listName: null, source: "Личное",
    status: "accepted", title: "Дело", ...extra,
  };
}

function review(extra: Partial<WeeklyReviewInput> = {}): WeeklyReviewInput {
  return { closedLastWeek: 0, now: NOW, tasks: [], timezone: "Europe/Moscow", waiting: [], ...extra };
}

describe("weekly review", () => {
  it("stays silent when there is nothing to look through", () => {
    expect(formatWeeklyReview(review())).toBeNull();
    // Закрытые дела недели это не повод писать: пересматривать в них нечего.
    expect(formatWeeklyReview(review({ closedLastWeek: 7 }))).toBeNull();
    // Дело со сроком на будущее и с личным планом тоже ждать не заставляет.
    expect(formatWeeklyReview(review({ tasks: [task({ dueOn: "2026-10-10" })] }))).toBeNull();
    expect(formatWeeklyReview(review({
      tasks: [task({ plannedFrom: "2026-09-28", plannedUntil: "2026-09-29" })],
    }))).toBeNull();
  });

  it("never sends a week of ideas alone", () => {
    const ideas = [task({ kind: "idea", title: "Съездить в Тбилиси" }), task({ kind: "idea", title: "Гитара" })];

    expect(formatWeeklyReview(review({ tasks: ideas }))).toBeNull();
    // Но рядом с просроченным делом идеи уже видны как счётчик.
    const text = formatWeeklyReview(review({ tasks: [...ideas, task({ dueOn: "2026-09-20" })] }))!;
    expect(text).toContain("Идей на «когда-нибудь»: 2");
  });

  it("puts overdue first, then waiting, then tasks without a next step", () => {
    const text = formatWeeklyReview(review({
      closedLastWeek: 3,
      tasks: [
        task({ dueOn: "2026-09-20", title: "Записаться к врачу" }),
        task({ title: "Разобрать гараж" }),
        task({ kind: "idea", title: "Гитара" }),
      ],
      waiting: [task({ status: "proposed", title: "Купить билеты" })],
    }))!;

    const order = ["Просрочено", "Записаться к врачу", "Жду ответа", "Купить билеты",
      "Без следующего шага", "Разобрать гараж", "Идей на «когда-нибудь»: 1"];
    let cursor = -1;
    for (const fragment of order) {
      const next = text.indexOf(fragment);
      expect(next, fragment).toBeGreaterThan(cursor);
      cursor = next;
    }
    expect(text).toContain("За неделю закрыто: 3");
    expect(text).toContain("— срок 20.09");
  });

  it("asks exactly three questions and offers to act and to switch off", () => {
    const text = formatWeeklyReview(review({ tasks: [task({ dueOn: "2026-09-20" })] }))!;

    expect(WEEKLY_REVIEW_QUESTIONS).toEqual([
      "Что на этой неделе помогло?", "Что давит?", "Что можно убрать?",
    ]);
    for (const question of WEEKLY_REVIEW_QUESTIONS) expect(text).toContain(question);
    expect(text.match(/\?/gu)).toHaveLength(WEEKLY_REVIEW_QUESTIONS.length);
    expect(text).toContain("Скажи, что закрыть, отложить, передать или снять — сделаю.");
    expect(text).toContain("«Хватит обзоров» — выключу.");
  });

  it("shortens a long section instead of listing everything", () => {
    const many = Array.from({ length: 8 }, (_, index) => task({ title: `Дело ${index + 1}`, dueOn: "2026-09-20" }));

    const text = formatWeeklyReview(review({ tasks: many }))!;

    expect(text).toContain("Просрочено · 8");
    expect(text).toContain("…и ещё 3");
    expect(text).not.toContain("Дело 6");
  });
});
