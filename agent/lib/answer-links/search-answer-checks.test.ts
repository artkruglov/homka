/**
 * Машинные проверки ответа с поиском ловят уверенный тон без источника, пересказ недоступного
 * сайта, старую афишу без срока и один источник там, где их два.
 */
import { describe, expect, it } from "vitest";

import { checkSearchAnswer } from "./search-answer-checks.js";

describe("checkSearchAnswer", () => {
  it("fails an answer that names no source at all", () => {
    expect(checkSearchAnswer("Концерт в субботу в семь вечера.", ["names_link"]).failed)
      .toEqual(["names_link"]);
    expect(checkSearchAnswer("Концерт в субботу: https://afisha.example/x", ["names_link"]).failed)
      .toEqual([]);
  });

  it("fails an answer that retells a site it could not open", () => {
    expect(checkSearchAnswer("На сайте написано, что магазин работает до девяти.",
      ["admits_unavailable"]).failed).toEqual(["admits_unavailable"]);
    expect(checkSearchAnswer("Сайт не открылся, поэтому подтвердить часы работы не могу.",
      ["admits_unavailable"]).failed).toEqual([]);
  });

  it("fails an answer about something that ages without saying when", () => {
    expect(checkSearchAnswer("Выставка идёт, билеты есть.", ["dates_the_answer"]).failed)
      .toEqual(["dates_the_answer"]);
    expect(checkSearchAnswer("Выставка до 14 октября, проверьте на сайте перед поездкой.",
      ["dates_the_answer"]).failed).toEqual([]);
  });

  it("fails an answer that silently picks one of two disagreeing sources", () => {
    expect(checkSearchAnswer("Цена 3200 рублей: https://one.example/a", ["names_two_sources"]).failed)
      .toEqual(["names_two_sources"]);
    expect(checkSearchAnswer("Источники расходятся: 3200 и 3600 рублей.", ["names_two_sources"]).failed)
      .toEqual([]);
    expect(checkSearchAnswer("https://one.example/a — 3200, https://two.example/b — 3600",
      ["names_two_sources"]).failed).toEqual([]);
  });

  it("returns the hosts it saw, so a report can be read without the full addresses", () => {
    expect(checkSearchAnswer("https://one.example/a и https://one.example/b", []).hosts)
      .toEqual(["one.example"]);
  });
});
