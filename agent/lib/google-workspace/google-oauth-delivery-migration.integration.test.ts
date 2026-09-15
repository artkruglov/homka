/**
 * OAuth authorization delivery migration integration test.
 *
 * Construct covered:
 * - `048_oauth_authorization_delivery_state.sql`: historical pending links become ambiguous.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";

const integrationTestsEnabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const describeWithDatabase = integrationTestsEnabled ? describe : describe.skip;
const TEST_SCHEMA = "oauth_delivery_migration_test";

describeWithDatabase("048 OAuth authorization delivery state", () => {
  afterAll(async () => {
    await database().query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await closeDatabase();
  });

  it("marks only historical pending states as started and unconfirmed", async () => {
    const migrationSql = await readFile(
      resolve("migrations/048_oauth_authorization_delivery_state.sql"),
      "utf8",
    );
    const client = await database().connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      await client.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
      await client.query(`SET search_path TO ${TEST_SCHEMA}, public`);
      await client.query(`
        CREATE TABLE oauth_authorizations (
          id integer PRIMARY KEY,
          status text NOT NULL,
          created_at timestamptz NOT NULL
        );
        INSERT INTO oauth_authorizations (id, status, created_at) VALUES
          (1, 'pending', '2026-08-05T10:00:00Z'),
          (2, 'completed', '2026-08-05T11:00:00Z');
      `);

      await client.query(migrationSql);

      const result = await client.query<{
        deliveryCompletedAt: Date | null;
        deliveryStartedAt: Date | null;
        id: number;
      }>(`SELECT id, delivery_started_at AS "deliveryStartedAt",
                 delivery_completed_at AS "deliveryCompletedAt"
          FROM oauth_authorizations ORDER BY id`);
      expect(result.rows).toEqual([
        {
          deliveryCompletedAt: null,
          deliveryStartedAt: new Date("2026-08-05T10:00:00.000Z"),
          id: 1,
        },
        { deliveryCompletedAt: null, deliveryStartedAt: null, id: 2 },
      ]);
    } finally {
      client.release();
    }
  });
});
