/**
 * Запас места.
 *
 * Проверяется: в тихий день строки нет; мало свободного — есть; база больше свободного места —
 * сказано прямо, что откат не поместится; неизвестное место молчит, а не пугает нулём.
 */
import { describe, expect, it } from "vitest";

import { formatStorageHeadroom, STORAGE_HEADROOM_WARNING_FRACTION } from "./storage-headroom.js";

const gib = 1024 ** 3;

describe("formatStorageHeadroom", () => {
  it("says nothing while there is room", () => {
    expect(formatStorageHeadroom({ databaseBytes: gib, freeBytes: 40 * gib, totalBytes: 100 * gib }))
      .toBeNull();
  });

  it("names the numbers once the free share drops below the threshold", () => {
    const text = formatStorageHeadroom({
      databaseBytes: gib, freeBytes: 10 * gib, totalBytes: 100 * gib,
    })!;
    expect(text).toContain("свободно 10.0 ГиБ из 100.0 ГиБ (10 %)");
    expect(text).toContain("база 1.0 ГиБ");
    expect(STORAGE_HEADROOM_WARNING_FRACTION).toBeLessThan(0.5);
  });

  it("says plainly that a rollback no longer fits, even on a roomy disk", () => {
    expect(formatStorageHeadroom({ databaseBytes: 30 * gib, freeBytes: 50 * gib, totalBytes: 100 * gib }))
      .toContain("Две копии дампа уже не помещаются");
  });

  it("keeps quiet when the filesystem could not be read at all", () => {
    expect(formatStorageHeadroom({ databaseBytes: gib, freeBytes: null, totalBytes: null }))
      .toBeNull();
  });
});
