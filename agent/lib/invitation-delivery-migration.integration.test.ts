/**
 * Invitation delivery ambiguity migration integration test.
 *
 * Construct covered:
 * - `046_invitation_delivery_attempts.sql`: legacy open rows become fail-closed delivery attempts.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";

const integrationTestsEnabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const describeWithDatabase = integrationTestsEnabled ? describe : describe.skip;
const TEST_SCHEMA = "invitation_delivery_migration_test";

describeWithDatabase("046 invitation delivery attempts", () => {
  afterAll(async () => {
    await database().query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await closeDatabase();
  });

  it("marks every legacy invitation as started even when completion was never recorded", async () => {
    const migrationSql = await readFile(
      resolve("migrations/046_invitation_delivery_attempts.sql"),
      "utf8",
    );
    const client = await database().connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      await client.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
      await client.query(`SET search_path TO ${TEST_SCHEMA}, public`);
      await client.query(`
        CREATE TABLE invitations (
          id integer PRIMARY KEY,
          created_at timestamptz NOT NULL,
          delivery_completed_at timestamptz
        );
        INSERT INTO invitations (id, created_at, delivery_completed_at) VALUES
          (1, '2026-08-05T10:00:00Z', NULL),
          (2, '2026-08-05T11:00:00Z', '2026-08-05T11:01:00Z');
      `);

      await client.query(migrationSql);

      const result = await client.query<{
        deliveryCompletedAt: Date | null;
        deliveryStartedAt: Date;
        id: number;
      }>(`SELECT id, delivery_started_at AS "deliveryStartedAt",
                 delivery_completed_at AS "deliveryCompletedAt"
          FROM invitations ORDER BY id`);
      expect(result.rows).toEqual([
        {
          deliveryCompletedAt: null,
          deliveryStartedAt: new Date("2026-08-05T10:00:00.000Z"),
          id: 1,
        },
        {
          deliveryCompletedAt: new Date("2026-08-05T11:01:00.000Z"),
          deliveryStartedAt: new Date("2026-08-05T11:01:00.000Z"),
          id: 2,
        },
      ]);
    } finally {
      client.release();
    }
  });
});
