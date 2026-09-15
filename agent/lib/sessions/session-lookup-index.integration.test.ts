/**
 * Поиск сессии и выбор следующего поколения идут по `conversation_key`. У тихой проверки памяти
 * этот ключ уникален для каждого пакета, поэтому без индекса минутный диспетчер читал таблицу
 * сессий целиком на каждый пакет каждого лейна.
 */
import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";

const dbDescribe = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;

dbDescribe("conversation session lookup", () => {
  afterAll(closeDatabase);

  it("indexes the conversation key that both session lookups select on", async () => {
    // Планировщик на маленькой таблице всё равно выберет последовательный проход, поэтому
    // проверяется наличие самого индекса с нужной ведущей колонкой, а не выбранный план.
    const leading = (await database().query<{ column_name: string | null }>(
      `SELECT a.attname AS column_name
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indrelid
         LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = i.indkey[0]
        WHERE c.relname = 'conversation_sessions' AND i.indisvalid`,
    )).rows.map((row) => row.column_name);
    expect(leading).toContain("conversation_key");
  });
});
