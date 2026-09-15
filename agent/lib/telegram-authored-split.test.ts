/**
 * Authored Telegram aside splitting tests.
 *
 * Constructs covered:
 * - `splitTelegramAuthoredParts`: every part the author separated becomes its own message.
 * - Only the delivery ceiling merges parts back; shape stays the author's decision.
 * - Directives inside fenced or indented code stay literal content of the answer.
 * - A directive written anywhere but on its own line is removed instead of reaching a person.
 * - A closing or self-closing tag spelling and the upstream `[[split]]` marker never reach a person.
 * - `stripTelegramAsideDirectives`: durable projection text without transport directives.
 */
import { describe, expect, it } from "vitest";

import {
  splitTelegramAuthoredParts,
  stripTelegramAsideDirectives,
  TELEGRAM_ASIDE_DIRECTIVE,
} from "./telegram-authored-split.js";

const directive = TELEGRAM_ASIDE_DIRECTIVE;

describe("splitTelegramAuthoredParts", () => {
  it("keeps an ordinary answer as a single main message", () => {
    expect(splitTelegramAuthoredParts("Счёт за август — 12 долларов")).toEqual({
      asides: [],
      main: "Счёт за август — 12 долларов",
    });
  });

  it("splits the authored aside away from the main answer", () => {
    const markdown = `Счёт за август — 12 долларов\n${directive}\nа, и да — почти всё это один голосовой на 40 минут`;

    expect(splitTelegramAuthoredParts(markdown)).toEqual({
      asides: ["а, и да — почти всё это один голосовой на 40 минут"],
      main: "Счёт за август — 12 долларов",
    });
  });

  it("keeps every part the author separated", () => {
    const markdown = `Основной ответ\n${directive}\nвывод\n${directive}\nхотя если так пойдёт дальше, дешевле резать на куски\n${directive}\nа ещё это влияет на счёт`;

    expect(splitTelegramAuthoredParts(markdown)).toEqual({
      asides: [
        "вывод",
        "хотя если так пойдёт дальше, дешевле резать на куски",
        "а ещё это влияет на счёт",
      ],
      main: "Основной ответ",
    });
  });

  it.each([
    ["long", "а".repeat(900)],
    ["multi-paragraph", "первый абзац\n\nвторой абзац"],
    ["list", "- первый пункт\n- второй пункт"],
    ["heading", "## Итог"],
  ])("leaves a %s part as its own message", (_kind, part) => {
    const markdown = `Основной ответ\n${directive}\n${part}`;

    expect(splitTelegramAuthoredParts(markdown)).toEqual({
      asides: [part],
      main: "Основной ответ",
    });
  });

  it("merges everything past the delivery ceiling into the last message", () => {
    const parts = Array.from({ length: 7 }, (_, index) => `часть ${index + 1}`);
    const markdown = parts.join(`\n${directive}\n`);

    expect(splitTelegramAuthoredParts(markdown)).toEqual({
      asides: ["часть 2", "часть 3", "часть 4", "часть 5\n\nчасть 6\n\nчасть 7"],
      main: "часть 1",
    });
  });

  it("keeps a fenced directive as literal answer content", () => {
    const markdown = `Вот пример:\n\n\`\`\`\n${directive}\n\`\`\``;

    expect(splitTelegramAuthoredParts(markdown)).toEqual({ asides: [], main: markdown });
  });

  it.each([
    ["closing tag", "</telegram-split>"],
    ["self-closing tag", "<telegram-split/>"],
    ["spaced self-closing tag", "<telegram-split />"],
    ["upstream marker", "[[split]]"],
  ])("splits on a %s line so the spelling never leaks", (_kind, spelling) => {
    expect(splitTelegramAuthoredParts(`Ответ\n${spelling}\nдобивка`)).toEqual({
      asides: ["добивка"],
      main: "Ответ",
    });
  });

  it("removes a closing tag the model appended after the last message", () => {
    // The directive looks like an XML tag, so the model sometimes closes it at the end.
    const markdown = `Первое сообщение\n${directive}\nа вот второе. </telegram-split>`;

    expect(splitTelegramAuthoredParts(markdown)).toEqual({
      asides: ["а вот второе."],
      main: "Первое сообщение",
    });
  });

  it("removes a tag pair wrapped around an aside", () => {
    expect(splitTelegramAuthoredParts("Ответ\n<telegram-split>добивка</telegram-split>")).toEqual({
      asides: [],
      main: "Ответ\nдобивка",
    });
  });

  it("does not treat a directive followed by text as a separator line", () => {
    expect(splitTelegramAuthoredParts(`Ответ\n${directive} и сразу текст`)).toEqual({
      asides: [],
      main: "Ответ\n и сразу текст",
    });
  });

  it("keeps an indented directive as literal code content", () => {
    const markdown = `Пример разметки:\n\n    ${directive}\n\nВот так.`;

    expect(splitTelegramAuthoredParts(markdown)).toEqual({ asides: [], main: markdown });
  });

  it("tracks fence length so a nested fence does not shift the code boundary", () => {
    const markdown = `\`\`\`\`\nвнутри\n\`\`\`\nещё внутри\n\`\`\`\`\n${directive}\nкстати`;

    expect(splitTelegramAuthoredParts(markdown)).toEqual({
      asides: ["кстати"],
      main: "````\nвнутри\n```\nещё внутри\n````",
    });
  });

  it("keeps a directive inside a tilde fenced block", () => {
    const markdown = `Пример:\n\n~~~\n${directive}\n~~~`;

    expect(splitTelegramAuthoredParts(markdown)).toEqual({ asides: [], main: markdown });
  });

  it("does not let a tilde line close a backtick fence", () => {
    const markdown = `\`\`\`\n~~~\n${directive}\n\`\`\`\n${directive}\nкстати`;

    expect(splitTelegramAuthoredParts(markdown)).toEqual({
      asides: ["кстати"],
      main: "```\n~~~\n" + directive + "\n```",
    });
  });

  it("removes a directive written inside a sentence", () => {
    expect(splitTelegramAuthoredParts(`Ответ готов ${directive} кстати вот ещё`)).toEqual({
      asides: [],
      main: "Ответ готов кстати вот ещё",
    });
  });

  it("removes a directive wrapped in inline formatting", () => {
    expect(splitTelegramAuthoredParts(`Ответ\n**${directive}**\nкстати`)).toEqual({
      asides: [],
      main: "Ответ\n****\nкстати",
    });
  });

  it("splits a directive line that carries trailing whitespace", () => {
    expect(splitTelegramAuthoredParts(`Ответ\n${directive}   \nдобивка`)).toEqual({
      asides: ["добивка"],
      main: "Ответ",
    });
  });

  it("splits across CRLF line endings", () => {
    expect(splitTelegramAuthoredParts(`Ответ\r\n${directive}\r\nдобивка`)).toEqual({
      asides: ["добивка"],
      main: "Ответ",
    });
  });

  it("treats a directive-only answer as empty output", () => {
    expect(splitTelegramAuthoredParts(`  ${directive}  `)).toEqual({ asides: [], main: "" });
  });

  it("uses the first non-empty part as the main answer", () => {
    expect(splitTelegramAuthoredParts(`${directive}\nОтвет\n${directive}\nдобивка`)).toEqual({
      asides: ["добивка"],
      main: "Ответ",
    });
  });
});

describe("stripTelegramAsideDirectives", () => {
  it("removes directives from the durable conversation projection", () => {
    const markdown = `Основной ответ\n${directive}\nдобивка`;

    expect(stripTelegramAsideDirectives(markdown)).toBe("Основной ответ\n\nдобивка");
  });

  it("keeps a fenced directive inside the stored answer", () => {
    const markdown = `Пример:\n\n\`\`\`\n${directive}\n\`\`\``;

    expect(stripTelegramAsideDirectives(markdown)).toBe(markdown);
  });
});
