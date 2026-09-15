/**
 * Private-only memory-thread notice policy migration test.
 *
 * Constructs covered:
 * - Migration 061 terminally suppresses pending group-origin notices only.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";

const TEST_SCHEMA = "thread_notice_policy_migration_test";
const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;

describeWithDatabase("private-only thread notice migration", () => {
  afterAll(closeDatabase);

  it("suppresses pending group origins without changing private or presented notices", async () => {
    const client = await database().connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      await client.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
      await client.query(`SET search_path TO ${TEST_SCHEMA}, public`);
      await client.query(`
        CREATE TABLE application_conversations (
          id uuid PRIMARY KEY,
          telegram_group_id uuid
        );
        CREATE TABLE memory_thread_entries (
          id uuid PRIMARY KEY,
          thread_id uuid NOT NULL,
          source_claim_id uuid,
          created_at timestamptz NOT NULL
        );
        CREATE TABLE claim_evidence (
          claim_id uuid NOT NULL,
          evidence_role text NOT NULL,
          origin_conversation_id uuid NOT NULL
        );
        CREATE TABLE memory_thread_creation_notices (
          thread_id uuid PRIMARY KEY,
          status text NOT NULL,
          delivery_token uuid,
          delivery_started_at timestamptz,
          delivery_diagnostic_code text,
          presented_at timestamptz,
          created_at timestamptz NOT NULL DEFAULT now()
        );
      `);
      await client.query(`
        INSERT INTO application_conversations (id, telegram_group_id) VALUES
          ('10000000-0000-4000-8000-000000000001', NULL),
          ('10000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000001');
        INSERT INTO memory_thread_entries (id, thread_id, source_claim_id, created_at) VALUES
          ('30000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001',
           '50000000-0000-4000-8000-000000000001', now()),
          ('30000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000002',
           '50000000-0000-4000-8000-000000000002', now()),
          ('30000000-0000-4000-8000-000000000003', '40000000-0000-4000-8000-000000000003',
           '50000000-0000-4000-8000-000000000003', now());
        INSERT INTO claim_evidence (claim_id, evidence_role, origin_conversation_id) VALUES
          ('50000000-0000-4000-8000-000000000001', 'primary',
           '10000000-0000-4000-8000-000000000001'),
          ('50000000-0000-4000-8000-000000000002', 'primary',
           '10000000-0000-4000-8000-000000000002'),
          ('50000000-0000-4000-8000-000000000003', 'primary',
           '10000000-0000-4000-8000-000000000002');
        INSERT INTO memory_thread_creation_notices
          (thread_id, status, delivery_started_at, presented_at) VALUES
          ('40000000-0000-4000-8000-000000000001', 'pending', NULL, NULL),
          ('40000000-0000-4000-8000-000000000002', 'pending', NULL, NULL),
          ('40000000-0000-4000-8000-000000000003', 'presented', now(), now()),
          ('40000000-0000-4000-8000-000000000004', 'pending', NULL, NULL);
      `);

      await client.query(await readFile(
        resolve("migrations/061_private_memory_thread_notices.sql"),
        "utf8",
      ));

      await expect(client.query(
        `SELECT status, delivery_diagnostic_code, delivery_started_at IS NOT NULL AS started
         FROM memory_thread_creation_notices ORDER BY thread_id`,
      )).resolves.toMatchObject({ rows: [
        { delivery_diagnostic_code: null, started: false, status: "pending" },
        {
          delivery_diagnostic_code: "AGENT_MEMORY_THREAD_NOTICE_PRIVATE_ONLY",
          started: true,
          status: "failed",
        },
        { delivery_diagnostic_code: null, started: true, status: "presented" },
        {
          delivery_diagnostic_code: "AGENT_MEMORY_THREAD_NOTICE_PRIVATE_ONLY",
          started: true,
          status: "failed",
        },
      ] });
    } finally {
      await client.query("RESET search_path");
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      client.release();
    }
  });
});
