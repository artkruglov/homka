/**
 * Выдуманная ссылка.
 *
 * Проверяется: ход без поиска и без открытия страницы, назвавший чужой адрес, считается
 * выдумавшим его; принесённый человеком адрес — нет; после поиска судить не о чем, потому что
 * источники провайдера приложению не видны.
 */
import { describe, expect, it } from "vitest";

import { createAnswerLinkAudit, extractLinks } from "./answer-links.js";

describe("answer links", () => {
  it("reads the addresses out of a text without their trailing punctuation", () => {
    expect(extractLinks("Смотри https://example.com/a, и ещё (https://example.org/b)."))
      .toEqual(["https://example.com/a", "https://example.org/b"]);
  });

  it("counts a link that the turn could not have got from anywhere", () => {
    const audit = createAnswerLinkAudit();
    expect(audit.completed("turn-1", "Вот расписание: https://afisha.example/october").unsourcedHosts)
      .toEqual(["afisha.example"]);
  });

  it("says nothing about a link the person brought themselves", () => {
    const audit = createAnswerLinkAudit();
    audit.received("turn-2", "Посмотри https://afisha.example/october");
    expect(audit.completed("turn-2", "По ссылке https://afisha.example/october концерт в семь")
      .unsourcedHosts).toEqual([]);
  });

  it("judges nothing once the turn has searched, because those sources are invisible here", () => {
    const audit = createAnswerLinkAudit();
    audit.searched("turn-3");
    expect(audit.completed("turn-3", "Нашла: https://afisha.example/october").unsourcedHosts)
      .toEqual([]);
  });

  it("keeps an opened page as a source of its own", () => {
    const audit = createAnswerLinkAudit();
    audit.fetched("turn-4", "https://afisha.example/october");
    expect(audit.completed("turn-4", "Там сказано: https://afisha.example/october").unsourcedHosts)
      .toEqual([]);
  });

  it("forgets a turn once it is judged and does not grow forever", () => {
    const audit = createAnswerLinkAudit();
    audit.received("turn-5", "https://example.com/a");
    audit.completed("turn-5", "ok");
    // Тот же ход второй раз ничего не помнит: состояние снято вместе с выводом.
    expect(audit.completed("turn-5", "Вот: https://example.com/a").unsourcedHosts)
      .toEqual(["example.com"]);
  });
});
