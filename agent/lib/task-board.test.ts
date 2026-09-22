import { describe, expect, it } from "vitest";

import { formatTaskBoard, taskBoardReply, type BoardTask } from "./task-board.js";
import { formatTelegramFinalPresentation } from "./telegram-final-presentation.js";

const NOW = new Date("2026-09-22T06:00:00Z");
const task = (title: string, extra: Partial<BoardTask> = {}): BoardTask => ({
  dueAt: null, dueOn: null, kind: "task", listName: null, source: "Личное", status: "accepted", title, ...extra,
});

describe("task board", () => {
  it("puts every open task in front of the person, overdue first, then by list", () => {
    const board = formatTaskBoard({
      now: NOW, style: "plain", timezone: "Europe/Moscow",
      tasks: [
        task("Договориться с мастером", { dueOn: "2026-09-15", listName: "Встречи" }),
        task("Встреча в Zoom", { dueAt: "2026-09-16T06:00:00Z", listName: "Встречи" }),
        task("Позвонить в банк", { dueOn: "2026-09-22", listName: "Дом" }),
        task("Продвинуться по продаже", { listName: "Работа" }),
        task("Написать отзыв", { listName: "Работа" }),
        task("Отвезти машину", { listName: "Дом" }),
        task("Найти мастеров для штор", { listName: "Дом", source: "Семья", status: "open" }),
        task("Венчур", { kind: "idea" }),
        task("Уже сделано", { status: "completed", listName: "Работа" }),
      ],
      waiting: [task("Саша забирает посылку", { status: "proposed" })],
    })!;

    expect(board.split("\n\n")).toEqual([
      "⚠️ Просрочено · 2\n• Договориться с мастером — срок 15.09\n• Встреча в Zoom — срок 16.09",
      "Сегодня · 1\n• Позвонить в банк",
      "Дом · 1\n• Отвезти машину",
      "Дом (Семья) · 1\n• Найти мастеров для штор · свободное",
      "Работа · 2\n• Продвинуться по продаже\n• Написать отзыв",
      "Жду ответа · 1\n• Саша забирает посылку · ждёт согласия",
      "Когда-нибудь · 1\n• Венчур",
      "Открытых дел: 7",
    ]);
  });

  it("folds a long list into its first items and a count, never into a hidden block", () => {
    const tasks = Array.from({ length: 8 }, (_, index) => task(`Дело ${index + 1}`, { listName: "Работа" }));
    const board = formatTaskBoard({ now: NOW, perGroup: 3, style: "plain", tasks, timezone: "UTC" })!;

    expect(board).toContain("Работа · 8\n• Дело 1\n• Дело 2\n• Дело 3\n…и ещё 5");
  });

  it("marks headings bold for a model answer and keeps a title from breaking them", () => {
    const board = formatTaskBoard({ now: NOW, style: "rich", timezone: "UTC", tasks: [task("Купить **всё**", { listName: "Дом" })] })!;

    expect(board).toContain("**Дом · 1**\n• Купить всё");
  });

  it("stays silent when nothing is open", () => {
    expect(formatTaskBoard({ now: NOW, style: "plain", timezone: "UTC", tasks: [task("Готово", { status: "completed" })] })).toBeNull();
  });

  it("gives the model a board that reaches the chat whole and bold", () => {
    const tasks = Array.from({ length: 30 }, (_, index) => task(`Дело с довольно длинным названием ${index + 1}`, { listName: index % 2 ? "Работа" : "Дом" }));
    const reply = taskBoardReply(tasks, NOW, "UTC")!;
    const delivered = formatTelegramFinalPresentation(reply).map((chunk) => chunk.text).join("\n");

    expect(delivered).not.toContain("Полный ответ");
    expect(delivered).not.toContain("telegram-keep-open");
    expect(delivered).toContain("Дело с довольно длинным названием 2");
    expect(taskBoardReply([], NOW, "UTC")).toBeNull();
  });
});
