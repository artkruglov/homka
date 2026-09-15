/**
 * Telegram Rich Message block-limit tests.
 *
 * Constructs covered:
 * - Every repeated nested list contributes its own provider block container.
 * - Oversized tables are split with a valid repeated header and delimiter.
 */
import { describe, expect, it } from "vitest";

import {
  estimateTelegramRichBlocks,
  splitTelegramRichBlockByCount,
} from "./telegram-rich-block-limits.js";

describe("Telegram rich block limits", () => {
  it("counts separate nested lists under separate parent items", () => {
    const markdown = Array.from(
      { length: 200 },
      (_, index) => `- родитель ${index + 1}\n  - ребёнок ${index + 1}`,
    ).join("\n");

    expect(estimateTelegramRichBlocks(markdown)).toBeGreaterThan(500);
  });

  it("repeats a GFM table header in every split chunk", () => {
    const table = [
      "Параметр | Значение",
      "--- | ---",
      ...Array.from({ length: 12 }, (_, index) => `ключ ${index + 1} | ${index + 1}`),
    ].join("\n");

    const chunks = splitTelegramRichBlockByCount(table, 6);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.startsWith("Параметр | Значение\n--- | ---\n"))).toBe(true);
    expect(chunks.join("\n")).toContain("ключ 12 | 12");
  });
});
