/**
 * Колонка `space_id` в таблице означает обязанность, а не украшение.
 *
 * Каталог покрытия выводит способ из каталога переноса, поэтому таблица, помеченная там `control`,
 * молча выходит из режима областей целиком — даже если колонка у неё есть и писатели её
 * заполняют. Ровно эту дыру каталог и должен закрывать, поэтому проверка идёт от схемы: список
 * таблиц берётся из самой базы, а не из того же каталога, который проверяется.
 */
import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { spaceEnforcementFor } from "./space-enforcement-catalog.js";

const dbDescribe = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;

dbDescribe("space enforcement coverage", () => {
  afterAll(closeDatabase);

  it("gives every table that carries an area a way to hold its boundary", async () => {
    const tables = (await database().query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND column_name = 'space_id'
        ORDER BY table_name`,
    )).rows.map((row) => row.table_name);
    expect(tables.length).toBeGreaterThan(10);
    const unguarded = tables.filter((table) => spaceEnforcementFor(table) === null);
    expect(unguarded).toEqual([]);
  });
});
