/**
 * Проверяется ровно одно: образ, который не знает применённой миграции, не поднимает сервис.
 */
import { describe, expect, it, vi } from "vitest";

import { requireSchemaWithinImage } from "./schema-image-guard.ts";

function ledger(names: string[]) {
  return { query: vi.fn().mockResolvedValue({ rows: names.map((name) => ({ name })) }) };
}

describe("schema image guard", () => {
  it("lets an image that knows every applied migration start", async () => {
    await expect(requireSchemaWithinImage(ledger(["001_a.sql", "002_b.sql"]), ["001_a.sql", "002_b.sql", "003_c.sql"]))
      .resolves.toBeUndefined();
  });

  it("refuses an image older than the schema it found, naming what it does not know", async () => {
    await expect(requireSchemaWithinImage(ledger(["001_a.sql", "112_new.sql"]), ["001_a.sql"]))
      .rejects.toThrowError(/AGENT_SCHEMA_AHEAD_OF_IMAGE: .*112_new\.sql/);
  });
});
