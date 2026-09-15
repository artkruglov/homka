/**
 * Migration 140 communication-style slot key integration test.
 *
 * Constructs covered:
 * - Records in the old persona-named slot ("общение с Мией") move to the neutral key the code now
 *   uses, so a family keeps its style records after the persona name became configuration.
 * - Other attributes and deleted rows' neighbours are left as they are; a second run changes nothing.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";
import { MEMORY_COMMUNICATION_STYLE_ATTRIBUTE } from "./memory-config.js";
import { createMemoryFamilyFixture, createMemoryInput } from "./memory-repository.integration-fixtures.js";
import { memoryRepository } from "./memory-repository.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;

describeWithDatabase("migration 140: neutral communication-style slot key", () => {
  afterAll(closeDatabase);

  it("renames the persona-named slot and leaves other slots alone", async () => {
    const family = await createMemoryFamilyFixture(`style-slot-${Date.now()}`);
    const style = await memoryRepository.create(family.owner, createMemoryInput("personal", `style-${Date.now()}`, "Любит короткие ответы"));
    const city = await memoryRepository.create(family.owner, createMemoryInput("personal", `city-${Date.now()}`, "Живёт в Твери"));
    await database().query("UPDATE memory_items_all SET attribute = 'общение с Мией' WHERE id = $1", [style.id]);
    await database().query("UPDATE memory_items_all SET attribute = 'город' WHERE id = $1", [city.id]);

    const sql = await readFile(resolve("migrations", "140_memory_communication_style_attribute.sql"), "utf8");
    await database().query(sql);
    await database().query(sql);

    const rows = await database().query<{ attribute: string; id: string }>(
      "SELECT id, attribute FROM memory_items_all WHERE id = ANY($1::uuid[])",
      [[style.id, city.id]],
    );
    const byId = new Map(rows.rows.map((row) => [row.id, row.attribute]));
    expect(MEMORY_COMMUNICATION_STYLE_ATTRIBUTE).toBe("общение с ассистентом");
    expect(byId.get(style.id)).toBe(MEMORY_COMMUNICATION_STYLE_ATTRIBUTE);
    expect(byId.get(city.id)).toBe("город");
  });
});
