/**
 * Provider-native web search cleanup migration integration test.
 *
 * Constructs covered:
 * - `047_remove_external_web_search_grants.sql`: removes grants that cannot be re-authorized at
 *   execution time while preserving every locally enforceable external capability.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";

const integrationTestsEnabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const describeWithDatabase = integrationTestsEnabled ? describe : describe.skip;
const TEST_SCHEMA = "external_web_search_cleanup_test";

describeWithDatabase("047 external web search grant cleanup", () => {
  afterAll(async () => {
    await database().query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await closeDatabase();
  });

  it("removes web_search from every persisted allowlist without changing other grants", async () => {
    const migrationSql = await readFile(
      resolve("migrations/047_remove_external_web_search_grants.sql"),
      "utf8",
    );
    const client = await database().connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      await client.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
      await client.query(`SET search_path TO ${TEST_SCHEMA}, public`);

      // The minimal table proves exact persisted-policy cleanup independently of later schema.
      await client.query(`
        CREATE TABLE telegram_groups (id integer PRIMARY KEY, tool_allowlist text[] NOT NULL);
        INSERT INTO telegram_groups (id, tool_allowlist) VALUES
          (1, ARRAY['remember', 'web_search', 'web_fetch']),
          (2, ARRAY['search_memories']);
      `);

      await client.query(migrationSql);

      const result = await client.query<{ id: number; tool_allowlist: string[] }>(
        "SELECT id, tool_allowlist FROM telegram_groups ORDER BY id",
      );
      expect(result.rows).toEqual([
        { id: 1, tool_allowlist: ["remember", "web_fetch"] },
        { id: 2, tool_allowlist: ["search_memories"] },
      ]);
    } finally {
      client.release();
    }
  });
});
