/**
 * PostgreSQL R1 memory retrieval migration integration test.
 *
 * Constructs covered:
 * - Migration 050 installs a stored Russian morphology vector and its GIN index.
 * - R5 later adds a dedicated trigram index only for same-subject consolidation candidates.
 */
import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const databaseUrl = process.env.DATABASE_URL;
if (enabled && (!databaseUrl || !new URL(databaseUrl).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const describeWithDatabase = enabled ? describe : describe.skip;

describeWithDatabase("050 Russian memory retrieval migration", () => {
  afterAll(async () => closeDatabase());

  it("keeps morphology retrieval and adds the separate active-claim consolidation index", async () => {
    const column = await database().query<{ generation_expression: string; is_generated: string }>(
      `SELECT is_generated, generation_expression
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'memory_items_all'
          AND column_name = 'russian_search_vector'`,
    );
    const indexes = await database().query<{ indexdef: string; indexname: string }>(
      `SELECT indexdef, indexname
         FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'memory_items_all'`,
    );

    expect(column.rows[0]).toEqual({
      generation_expression: "to_tsvector('russian'::regconfig, content)",
      is_generated: "ALWAYS",
    });
    expect(indexes.rows.map((row) => row.indexname)).toContain("memory_items_russian_search_vector_idx");
    expect(indexes.rows.map((row) => row.indexname)).toContain("memory_items_active_content_trgm");
    expect(indexes.rows.map((row) => row.indexdef).join("\n")).toContain("gin_trgm_ops");
  });
});
