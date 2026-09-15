/**
 * Delivered agent-schedule repair migration tests.
 *
 * Constructs covered:
 * - Receipt-backed legacy running or ambiguous runs become completed.
 * - Runs without a Telegram delivery receipt remain untouched.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const describeWithDatabase = enabled ? describe : describe.skip;
const TEST_SCHEMA = "agent_schedule_delivery_repair_test";

describeWithDatabase("037 delivered agent schedule repair migration", () => {
  afterAll(async () => {
    await database().query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await closeDatabase();
  });

  it("repairs only non-terminal runs proven delivered by a receipt", async () => {
    const migration = await readFile(
      resolve("migrations/037_repair_delivered_agent_schedule_runs.sql"),
      "utf8",
    );
    const client = await database().connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      await client.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
      await client.query(`SET search_path TO ${TEST_SCHEMA}, public`);
      await client.query(`
        CREATE TYPE agent_schedule_run_status AS ENUM
          ('claimed', 'dispatching', 'running', 'completed', 'failed', 'ambiguous');
        CREATE TYPE proactive_delivery_source_kind AS ENUM ('agent_schedule', 'reminder');
        CREATE TABLE agent_schedules (
          id uuid PRIMARY KEY,
          status text NOT NULL
        );
        CREATE TABLE agent_schedule_runs (
          id uuid PRIMARY KEY,
          schedule_id uuid NOT NULL REFERENCES agent_schedules(id),
          status agent_schedule_run_status NOT NULL,
          completed_at timestamptz,
          error_code text,
          updated_at timestamptz NOT NULL
        );
        CREATE TABLE proactive_deliveries (
          id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          source_kind proactive_delivery_source_kind NOT NULL,
          source_id uuid NOT NULL,
          delivered_at timestamptz NOT NULL
        );
        INSERT INTO agent_schedules (id, status)
        VALUES ('10000000-0000-4000-8000-000000000001', 'active');
        INSERT INTO agent_schedule_runs
          (id, schedule_id, status, completed_at, error_code, updated_at)
        VALUES
          ('00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'running', NULL, NULL, '2026-07-21T07:00:00Z'),
          ('00000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'ambiguous', NULL, 'AGENT_SCHEDULE_DELIVERY_AMBIGUOUS', '2026-07-21T08:00:00Z'),
          ('00000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'running', NULL, NULL, '2026-07-21T09:00:00Z'),
          ('00000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', 'failed', '2026-07-21T10:00:00Z', 'MODEL_CALL_FAILED', '2026-07-21T10:00:00Z');
        INSERT INTO proactive_deliveries (source_kind, source_id, delivered_at)
        VALUES
          ('agent_schedule', '00000000-0000-4000-8000-000000000001', '2026-07-21T07:27:00Z'),
          ('agent_schedule', '00000000-0000-4000-8000-000000000002', '2026-07-21T08:27:00Z'),
          ('reminder', '00000000-0000-4000-8000-000000000003', '2026-07-21T09:27:00Z');
      `);

      await client.query(migration);

      const runs = await client.query<{
        completed_at: Date | null;
        error_code: string | null;
        id: string;
        status: string;
      }>("SELECT id, status, completed_at, error_code FROM agent_schedule_runs ORDER BY id");
      expect(runs.rows).toEqual([
        {
          completed_at: new Date("2026-07-21T07:27:00.000Z"),
          error_code: null,
          id: "00000000-0000-4000-8000-000000000001",
          status: "completed",
        },
        {
          completed_at: new Date("2026-07-21T08:27:00.000Z"),
          error_code: null,
          id: "00000000-0000-4000-8000-000000000002",
          status: "completed",
        },
        {
          completed_at: null,
          error_code: null,
          id: "00000000-0000-4000-8000-000000000003",
          status: "running",
        },
        {
          completed_at: new Date("2026-07-21T10:00:00.000Z"),
          error_code: "MODEL_CALL_FAILED",
          id: "00000000-0000-4000-8000-000000000004",
          status: "failed",
        },
      ]);

      // Unknown parent recurrence state must stop deployment instead of guessing a next run.
      await client.query(
        "UPDATE agent_schedules SET status = 'failed' WHERE id = '10000000-0000-4000-8000-000000000001'",
      );
      await client.query(
        `INSERT INTO proactive_deliveries (source_kind, source_id, delivered_at)
         VALUES ('agent_schedule', '00000000-0000-4000-8000-000000000003', '2026-07-21T09:27:00Z')`,
      );
      await expect(client.query(migration)).rejects.toThrowError(
        /AGENT_SCHEDULE_DELIVERY_REPAIR_PARENT_INVALID/u,
      );
      await expect(client.query(
        "SELECT status::text FROM agent_schedule_runs WHERE id = '00000000-0000-4000-8000-000000000003'",
      )).resolves.toMatchObject({ rows: [{ status: "running" }] });
    } finally {
      await client.query("SET search_path TO public");
      client.release();
    }
  });
});
