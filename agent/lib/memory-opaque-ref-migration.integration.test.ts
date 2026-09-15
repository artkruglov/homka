/**
 * Opaque memory reference migration integration tests.
 *
 * Constructs covered:
 * - Migration 049 backfills exactly one random model-safe ref for every existing memory item.
 * - References are unique, stable, non-UUID values with a cascade lifecycle tied to their item.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;
const TEST_SCHEMA = "test_memory_opaque_ref_migration";

describeWithDatabase("049 opaque memory reference migration", () => {
  afterAll(closeDatabase);

  it("backfills every item once and cascades only its mapping", async () => {
    const client = await database().connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      await client.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
      await client.query(`SET search_path TO ${TEST_SCHEMA}, public`);
      await client.query(`
        CREATE TABLE memory_items (id uuid PRIMARY KEY);
        INSERT INTO memory_items VALUES
          ('00000000-0000-4000-8000-000000000001'),
          ('00000000-0000-4000-8000-000000000002');
      `);

      await client.query(await readFile(
        resolve("migrations/049_opaque_memory_refs.sql"),
        "utf8",
      ));

      const refs = await client.query<{ memory_item_id: string; memory_ref: string }>(`
        SELECT memory_item_id::text, memory_ref
        FROM memory_item_refs
        ORDER BY memory_item_id
      `);
      expect(refs.rows).toHaveLength(2);
      expect(new Set(refs.rows.map((row) => row.memory_ref)).size).toBe(2);
      for (const row of refs.rows) {
        expect(row.memory_ref).toMatch(/^mem_[0-9a-f]{32}$/u);
        expect(row.memory_ref).not.toMatch(/^[0-9a-f]{8}-/iu);
      }

      const stableRef = refs.rows[1]!.memory_ref;
      await client.query(
        "DELETE FROM memory_items WHERE id = '00000000-0000-4000-8000-000000000001'",
      );
      await expect(client.query(
        "SELECT memory_ref FROM memory_item_refs ORDER BY memory_ref",
      )).resolves.toMatchObject({ rows: [{ memory_ref: stableRef }] });

      // The invariant also covers every future insert, including writers outside the repository.
      await client.query(
        "INSERT INTO memory_items VALUES ('00000000-0000-4000-8000-000000000003')",
      );
      await expect(client.query<{ memory_ref: string }>(
        `SELECT memory_ref FROM memory_item_refs
         WHERE memory_item_id = '00000000-0000-4000-8000-000000000003'`,
      )).resolves.toMatchObject({
        rows: [{ memory_ref: expect.stringMatching(/^mem_[0-9a-f]{32}$/u) }],
      });
    } finally {
      try {
        await client.query("RESET search_path");
        await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      } finally {
        client.release();
      }
    }
  });
});
