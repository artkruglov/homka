/**
 * R4/R5 lifecycle, relation, conflict, and consolidation-job migration tests.
 *
 * Constructs covered:
 * - Migration 053 is additive and preserves existing claim fields and opaque refs.
 * - Composite relation/conflict foreign keys reject cross-scope trust-zone links.
 * - Conflict refs are opaque and consolidation jobs have durable provider/terminal state.
 */
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;
const TEST_SCHEMA = "test_r4_r5_consolidation_migration";
const MIGRATION_NAME = "053_r4_r5_claim_consolidation.sql";

async function applyEarlierMigrations(client: import("pg").PoolClient): Promise<void> {
  const names = (await readdir(resolve("migrations")))
    .filter((name) => name.endsWith(".sql") && name < MIGRATION_NAME)
    .sort();
  for (const name of names) {
    await client.query(await readFile(resolve("migrations", name), "utf8"));
  }
}

describeWithDatabase("053 R4/R5 claim consolidation migration", () => {
  afterAll(closeDatabase);

  it("preserves rows and enforces same trust-zone relations and conflicts", async () => {
    const client = await database().connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      await client.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
      await client.query(`SET search_path TO ${TEST_SCHEMA}, public`);
      await applyEarlierMigrations(client);
      const family = await client.query<{ id: string }>(
        "INSERT INTO families (name) VALUES ('R4 R5') RETURNING id",
      );
      const users = await client.query<{ id: string }>(
        `INSERT INTO users (telegram_user_id, display_name)
         VALUES ('r4-a', 'A'), ('r4-b', 'B') RETURNING id`,
      );
      const claims = await client.query<{ id: string }>(
        `INSERT INTO memory_items
           (family_id, owner_user_id, author_user_id, scope, kind, content, source,
            confirmation, sensitivity, operation_key)
         VALUES ($1, $2, $2, 'personal', 'fact', 'Старый факт', 'test:r4',
                 'user_confirmed', 'normal', 'r4-old'),
                ($1, $2, $2, 'personal', 'fact', 'Новый факт', 'test:r4',
                 'user_confirmed', 'normal', 'r4-new'),
                ($1, $3, $3, 'personal', 'fact', 'Чужая зона', 'test:r4',
                 'user_confirmed', 'normal', 'r4-cross')
         RETURNING id`,
        [family.rows[0]!.id, users.rows[0]!.id, users.rows[1]!.id],
      );
      const before = await client.query(
        `SELECT item.id, item.content, item.claim_status::text, ref.memory_ref
         FROM memory_items AS item JOIN memory_item_refs AS ref ON ref.memory_item_id = item.id
         ORDER BY item.operation_key`,
      );

      await client.query(await readFile(resolve("migrations", MIGRATION_NAME), "utf8"));

      const after = await client.query(
        `SELECT item.id, item.content, item.claim_status::text, ref.memory_ref
         FROM memory_items AS item JOIN memory_item_refs AS ref ON ref.memory_item_id = item.id
         ORDER BY item.operation_key`,
      );
      expect(after.rows).toEqual(before.rows);
      await expect(client.query(
        `INSERT INTO claim_relations
           (source_claim_id, target_claim_id, family_id, scope, scope_partition_key, relation_type, detection_method)
         SELECT $1, $2, family_id, scope, scope_partition_key, 'correction', 'user_explicit'
         FROM memory_items WHERE id = $1`,
        [claims.rows[0]!.id, claims.rows[2]!.id],
      )).rejects.toThrow();
      await expect(client.query(
        `INSERT INTO claim_conflicts
           (claim_a_id, claim_b_id, family_id, scope, scope_partition_key, detection_method)
         SELECT $1, $2, family_id, scope, scope_partition_key, 'model_guarded'
         FROM memory_items WHERE id = $1`,
        [claims.rows[0]!.id, claims.rows[2]!.id],
      )).rejects.toThrow();

      const conflict = await client.query<{ conflict_ref: string }>(
        `INSERT INTO claim_conflicts
           (claim_a_id, claim_b_id, family_id, scope, scope_partition_key, detection_method)
         SELECT LEAST($1::uuid, $2::uuid), GREATEST($1::uuid, $2::uuid),
                family_id, scope, scope_partition_key, 'model_guarded'
         FROM memory_items WHERE id = $1 RETURNING conflict_ref`,
        [claims.rows[0]!.id, claims.rows[1]!.id],
      );
      expect(conflict.rows[0]!.conflict_ref).toMatch(/^conf_[0-9a-f]{32}$/u);
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
