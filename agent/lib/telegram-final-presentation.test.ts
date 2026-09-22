/**
 * Telegram final-presentation selection tests.
 *
 * Constructs covered:
 * - Conversational text stays on the plain Telegram transport.
 * - Supported formatting selects Rich Message delivery.
 * - Long output is collapsed even when the model omits the mandatory details block.
 * - Authored asides become paced messages unless the answer is collapsed as long.
 */
import { describe, expect, it } from "vitest";

import { stripTelegramAsideDirectives } from "./telegram-authored-split.js";
import { formatTelegramFinalPresentation, TELEGRAM_KEEP_OPEN_DIRECTIVE } from "./telegram-final-presentation.js";
import { TELEGRAM_ASIDE_DIRECTIVE } from "./telegram-authored-split.js";

describe("Telegram final presentation", () => {
  it.each([
    "да не, ерунда, я пробовала",
    "можно попробовать\nно я бы не стала усложнять",
    "цена 2 * 3 доллара",
    "цена $5, скидка $2",
    "цена $5 + $2",
    "было $100 - $80",
  ])("keeps conversational text plain: %s", (text) => {
    expect(formatTelegramFinalPresentation(text))
      .toEqual([{ format: "plain", pacing: "immediate", text }]);
  });

  it.each([
    "**Да**, это важно",
    "## Итог\n\nГотово",
    "- первый вариант\n- второй вариант",
    "[Документация](https://example.com)",
    "«_важно_»",
    "<details><summary>Разбор</summary>\n\nТекст\n\n</details>",
  ])("selects Rich Message for supported formatting: %s", (markdown) => {
    expect(formatTelegramFinalPresentation(markdown)).toEqual([{
      format: "rich",
      pacing: "immediate",
      text: markdown,
    }]);
  });

  it("recognizes a GFM table without outer pipes and collapses it", () => {
    const markdown = "Параметр | Значение\n--- | ---\nрежим | plain";
    const output = formatTelegramFinalPresentation(markdown)[0]!;

    expect(output.format).toBe("rich");
    expect(output.text).toContain("<details><summary>Полный ответ</summary>");
    expect(output.text).toContain(markdown);
  });

  it.each([
    "а".repeat(601),
    "Смотри:\n\n```js\nconsole.log(1);\n```",
    "| a | b |\n| --- | --- |\n| 1 | 2 |",
  ])("collapses output past 600 characters and any code block or table", (text) => {
    const chunks = formatTelegramFinalPresentation(text);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ format: "rich" });
    expect(chunks[0]!.text).toContain("<details><summary>Полный ответ</summary>");
    expect(chunks[0]!.text).toContain("</details>");
  });

  // Verse, a short list or a few short paragraphs take little screen space; line, paragraph and
  // list-item counts hid a ten-line poem behind "Полный ответ" (8 сентября 2026).
  it.each([
    Array.from({ length: 10 }, (_, index) => `строка ${index + 1}`).join("\n"),
    "Раз-два-три-четыре-пять,\nГруз уехал погулять.\nОн вернётся через год,\nА Илья наоборот.\n\nНе грусти, Илья, не ной:\nГруз не помер, он живой.\nОн в другом краю живёт,\nХлеб жуёт и не зовёт.",
    "первый абзац\n\nвторой абзац\n\nтретий абзац",
    Array.from({ length: 6 }, (_, index) => `- пункт ${index + 1}`).join("\n"),
  ])("keeps a short answer whole whatever its line, paragraph or item count", (text) => {
    const chunks = formatTelegramFinalPresentation(text);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).not.toContain("<details>");
    expect(chunks[0]!.text).toContain(text.split("\n")[0]!);
  });

  it("collapses a long column of short lines whole instead of leaving one stanza outside", () => {
    const stanza = "строка стиха на восемь слов ровно тут\n".repeat(4).trim();
    const verse = Array.from({ length: 5 }, () => stanza).join("\n\n");
    const output = formatTelegramFinalPresentation(verse)[0]!.text;

    expect(output.startsWith("<details><summary>Полный ответ</summary>")).toBe(true);
    expect(output).toContain(stanza);
  });

  it("delivers an authored aside as its own paced message", () => {
    const markdown = `Счёт за август — 12 долларов\n${TELEGRAM_ASIDE_DIRECTIVE}\nа, и да — почти всё это один голосовой`;

    expect(formatTelegramFinalPresentation(markdown)).toEqual([
      { format: "plain", pacing: "immediate", text: "Счёт за август — 12 долларов" },
      { format: "plain", pacing: "aside", text: "а, и да — почти всё это один голосовой" },
    ]);
  });

  it("keeps aside pacing independent of the main answer transport", () => {
    const markdown = `**Итог:** счёт вырос втрое\n${TELEGRAM_ASIDE_DIRECTIVE}\nхотя это всё ещё меньше подписки`;
    const chunks = formatTelegramFinalPresentation(markdown);

    expect(chunks).toEqual([
      { format: "rich", pacing: "immediate", text: "**Итог:** счёт вырос втрое" },
      { format: "plain", pacing: "aside", text: "хотя это всё ещё меньше подписки" },
    ]);
  });

  it("collapses a long main answer without swallowing the aside", () => {
    const markdown = `${"подробность ".repeat(70)}\n${TELEGRAM_ASIDE_DIRECTIVE}\nвот такой расклад`;
    const chunks = formatTelegramFinalPresentation(markdown);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({ format: "rich", pacing: "immediate" });
    expect(chunks[0]!.text).toContain("<details><summary>Полный ответ</summary>");
    expect(chunks[1]).toEqual({ format: "plain", pacing: "aside", text: "вот такой расклад" });
  });

  it("keeps a structured aside as its own message", () => {
    const markdown = `Что делать\n${TELEGRAM_ASIDE_DIRECTIVE}\n- сначала одно\n- потом другое`;

    expect(formatTelegramFinalPresentation(markdown)).toEqual([
      { format: "plain", pacing: "immediate", text: "Что делать" },
      { format: "rich", pacing: "aside", text: "- сначала одно\n- потом другое" },
    ]);
  });

  it("keeps a short direct lead outside the generated accordion", () => {
    const body = "подробность ".repeat(70);

    expect(formatTelegramFinalPresentation(`короткий вывод\n\n${body}`)[0]!.text).toBe(
      `короткий вывод\n\n<details><summary>Полный ответ</summary>\n\n${body.trim()}\n\n</details>`,
    );
  });

  it("keeps a complete prose conclusion visible when it exceeds the old 240-character cutoff", () => {
    const lead = "Эта афиша относится к прошлому году. ".repeat(9).trim();
    const body = "Подробности из источника. ".repeat(30).trim();
    const output = formatTelegramFinalPresentation(`${lead}\n\n${body}`)[0]!.text;

    expect(output).toBe(
      `${lead}\n\n<details><summary>Полный ответ</summary>\n\n${body}\n\n</details>`,
    );
  });

  // SEARCH-14F-R3, 14 сентября 2026: ответ из трёх коротких пунктов чуть длиннее 600 символов
  // показывал только первый, и неизвестность про коляску пряталась под «Полный ответ».
  it("keeps consecutive short paragraphs visible up to the short-answer budget", () => {
    const hours = "19 сентября 2026 — суббота, музей работает по обычному расписанию: основная экспозиция с 10:00 до 18:00, касса до 17:30. Понедельник — единственный выходной, на эту дату он не влияет.";
    const stroller = "С коляской: правила про детскую коляску на официальных страницах нет — ни разрешения, ни запрета, ни проката. Это подтвердить не удалось, додумывать не буду.";
    const age = "По возрасту: на вход в саму экспозицию ограничений нет, только по билету. Ограничение «до 10 лет — только со взрослым» относится к занятиям, а не к посещению залов.";
    const tail = "Ссылки: https://www.darwinmuseum.ru/projects/constant-exp/info и https://www.darwinmuseum.ru/pages/visit-with-children?eng\n\nНичего не покупала, в память и задачи не сохраняла.";
    const markdown = [hours, stroller, age, tail].join("\n\n");
    expect(Array.from(markdown).length).toBeGreaterThan(600);

    const output = formatTelegramFinalPresentation(markdown)[0]!.text;

    expect(output).toBe(
      `${hours}\n\n${stroller}\n\n${age}\n\n<details><summary>Полный ответ</summary>\n\n${tail}\n\n</details>`,
    );
  });

  it("stops the visible lead at the first block that is not a short prose paragraph", () => {
    const list = Array.from({ length: 4 }, (_, index) => `- пункт ${index + 1}`).join("\n");
    const body = "подробность ".repeat(50).trim();
    const output = formatTelegramFinalPresentation(`короткий вывод\n\n${list}\n\nещё абзац\n\n${body}`)[0]!.text;

    expect(output).toBe(
      `короткий вывод\n\n<details><summary>Полный ответ</summary>\n\n${list}\n\nещё абзац\n\n${body}\n\n</details>`,
    );
  });

  it.each([600, 601])("uses the short-answer character budget for a prose lead of %i characters", (length) => {
    const lead = "я".repeat(length);
    const body = "подробности ".repeat(70).trim();
    const output = formatTelegramFinalPresentation(`${lead}\n\n${body}`)[0]!.text;

    expect(output.startsWith(`${lead}\n\n<details>`)).toBe(length <= 600);
    expect(output).toContain(lead);
    expect(output).toContain(body);
  });

  it("preserves an authored details block without wrapping it again", () => {
    const markdown = `<details><summary>Разбор</summary>\n\n${"текст ".repeat(150)}\n\n</details>`;

    expect(formatTelegramFinalPresentation(markdown))
      .toEqual([{ format: "rich", pacing: "immediate", text: markdown }]);
  });

  it("recognizes an indented valid details block", () => {
    const markdown = `  <details open><summary>Разбор</summary>\n\n${"текст ".repeat(150)}\n\n  </details>`;

    const output = formatTelegramFinalPresentation(markdown)[0]!.text;
    expect(output.match(/<details/gu)).toHaveLength(1);
    expect(output).toContain("<details open><summary>Разбор</summary>");
  });

  it("wraps a long block whose details tag has forbidden attributes", () => {
    const markdown = `<details class="wide"><summary>Разбор</summary>\n\n${"текст ".repeat(150)}\n\n</details>`;

    const output = formatTelegramFinalPresentation(markdown)[0]!.text;
    expect(output).toContain("<details><summary>Полный ответ</summary>");
    expect(output).toContain("&lt;details class=\"wide\"&gt;");
  });

  it.each([
    `<details>\n\n${"текст ".repeat(150)}\n\n</details>`,
    `<details><summary>Разбор\n\n${"текст ".repeat(150)}`,
  ])("wraps malformed authored details instead of trusting it: %s", (markdown) => {
    const output = formatTelegramFinalPresentation(markdown)[0]!.text;

    expect(output).toContain("<details><summary>Полный ответ</summary>");
    expect(output).toContain("&lt;details&gt;");
  });

  it("keeps a short rich warning outside the generated accordion", () => {
    const body = "подробность ".repeat(70);

    expect(formatTelegramFinalPresentation(`**Риск высокий.**\n\n${body}`)[0]!.text).toBe(
      `**Риск высокий.**\n\n<details><summary>Полный ответ</summary>\n\n${body.trim()}\n\n</details>`,
    );
  });
});

describe("a task board kept open", () => {
  const board = ["**Работа · 20**", ...Array.from({ length: 20 }, (_, i) => `• Дело номер ${i + 1} с подробным названием`),
    "", "**Дом · 3**", "• Отвезти машину", "• Подобрать страховку", "• Повесить шторы", "", "Открытых дел: 23"].join("\n");

  it("shows a board marked keep-open in full and never delivers the marker", () => {
    const text = formatTelegramFinalPresentation(`${TELEGRAM_KEEP_OPEN_DIRECTIVE}\n${board}\n\nЧто из этого уже сделано?`)
      .map((chunk) => chunk.text).join("\n");

    expect(text).not.toContain("Полный ответ");
    expect(text).not.toContain("telegram-keep-open");
    expect(text).toContain("Дело номер 20");
  });

  it("still folds the same long text when the model wrote it without the marker", () => {
    expect(formatTelegramFinalPresentation(board).map((chunk) => chunk.text).join("\n")).toContain("Полный ответ");
  });
});

describe("keep-open directive", () => {
  it("opens only for the directive on its own first line, not for a quoted title", () => {
    const quoted = `Дело называется <telegram-keep-open> и вот что по нему: ${"строка. ".repeat(120)}`;

    const delivered = formatTelegramFinalPresentation(quoted).map((chunk) => chunk.text).join("\n");

    expect(delivered).toContain("Полный ответ");
    expect(formatTelegramFinalPresentation(`<telegram-keep-open>\n${"строка. ".repeat(120)}`)
      .map((chunk) => chunk.text).join("\n")).not.toContain("Полный ответ");
  });

  it("never stores the directive in the durable projection", () => {
    expect(stripTelegramAsideDirectives("<telegram-keep-open>\nДоска")).toBe("Доска");
  });
});
