/** Уведомление называет, что адресовано человеку, кем и что с этим делать; согласия не выдумывает. */
import { describe, expect, it } from "vitest";

import { formatPartnerAlert, type PartnerAlertItem } from "./partner-alert.js";

const item = (extra: Partial<PartnerAlertItem> = {}): PartnerAlertItem => ({
  from: "Саша", kind: "task_proposed", repeated: false, subjectId: "s1", title: "Забрать посылку", ...extra,
});

describe("partner alert", () => {
  it("says nothing when nothing waits", () => {
    expect(formatPartnerAlert([])).toBeNull();
  });

  it("names every kind, who asked and what to answer", () => {
    const text = formatPartnerAlert([
      item(),
      item({ kind: "task_transfer", title: "Оплатить садик" }),
      item({ from: "Юра", kind: "care_area_proposed", title: "Документы" }),
      item({ kind: "decision_open", title: "Поехать к родителям" }),
    ], 3)!;

    expect(text).toContain("Дело (Саша): «Забрать посылку» — принять или отказаться.");
    expect(text).toContain("Передача дела (Саша): «Оплатить садик» — взять или вернуть.");
    expect(text).toContain("Область заботы (Юра): «Документы» — взять целиком или отказаться.");
    expect(text).toContain("Решение (Саша): «Поехать к родителям» — за, против или обсудить.");
    expect(text).toContain("…и ещё 3, покажу по просьбе.");
    expect(text).toContain("Молчание я согласием не считаю.");
  });

  it("marks the single repeat and never counts a third time", () => {
    expect(formatPartnerAlert([item({ repeated: true })])!)
      .toContain("уже спрашивала неделю назад");
  });

  it("keeps one long title from filling the message", () => {
    const text = formatPartnerAlert([item({ title: "я".repeat(400) })])!;

    expect(text).toContain("…»");
    expect(text.length).toBeLessThan(400);
  });
});
