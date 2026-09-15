/**
 * Keyset pagination cursor contract tests.
 *
 * Constructs covered:
 * - Filter-bound cursors cannot be reused against a different result set.
 * - Unfiltered cursors preserve the compact timestamp/identity contract.
 */
import { describe, expect, it } from "vitest";

import {
  decodeDateUuidCursor,
  encodeDateUuidCursor,
  paginationFilterDigest,
} from "./keyset-pagination.js";

const code = "AGENT_CURSOR_INVALID";
const message = "Не удалось продолжить просмотр";
const timestamp = new Date("2026-08-05T12:00:00.000Z");
const id = "00000000-0000-4000-8000-000000000001";

describe("filter-bound keyset cursors", () => {
  it("accepts only the exact normalized filter binding", () => {
    const familyFilter = paginationFilterDigest(["family"]);
    const personalFilter = paginationFilterDigest(["personal"]);
    const cursor = encodeDateUuidCursor(timestamp, id, familyFilter);

    expect(decodeDateUuidCursor(cursor, code, message, familyFilter)).toEqual({ id, timestamp });
    expect(() => decodeDateUuidCursor(cursor, code, message, personalFilter)).toThrowError(
      /AGENT_CURSOR_INVALID/u,
    );
  });

  it("rejects an unbound cursor when the result set requires a binding", () => {
    const cursor = encodeDateUuidCursor(timestamp, id);
    expect(() =>
      decodeDateUuidCursor(cursor, code, message, paginationFilterDigest([null]))
    ).toThrowError(/AGENT_CURSOR_INVALID/u);
  });

  it("rejects a cursor from another trusted identity with the same user filters", () => {
    const firstUser = paginationFilterDigest(["memory-v1", "family-1", "user-1", null]);
    const secondUser = paginationFilterDigest(["memory-v1", "family-1", "user-2", null]);
    const cursor = encodeDateUuidCursor(timestamp, id, firstUser);

    expect(() => decodeDateUuidCursor(cursor, code, message, secondUser)).toThrowError(
      /AGENT_CURSOR_INVALID/u,
    );
  });
});
