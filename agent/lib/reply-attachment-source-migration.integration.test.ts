/**
 * Reply attachment source migration integration tests.
 *
 * Constructs covered:
 * - Migration 043 backfills the source Telegram message for existing attachment references.
 * - The resulting shape rejects missing, orphaned, and non-positive source identifiers.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;
const TEST_SCHEMA = "test_reply_attachment_source_migration";

describeWithDatabase("043 reply attachment source migration", () => {
  afterAll(closeDatabase);

  it("backfills existing references and enforces a positive paired source ID", async () => {
    const client = await database().connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      await client.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
      await client.query(`SET search_path TO ${TEST_SCHEMA}, public`);
      await client.query(`
        CREATE TABLE telegram_group_messages (
          id uuid PRIMARY KEY,
          telegram_message_id bigint NOT NULL CHECK (telegram_message_id > 0),
          attachment_file_id text
        );
        INSERT INTO telegram_group_messages VALUES
          ('00000000-0000-4000-8000-000000000001', 41, 'telegram-file'),
          ('00000000-0000-4000-8000-000000000002', 42, NULL);
      `);

      await client.query(await readFile(
        resolve("migrations/043_reply_attachment_source.sql"),
        "utf8",
      ));

      await expect(client.query(
        `SELECT id::text, attachment_source_message_id::text
           FROM telegram_group_messages ORDER BY id`,
      )).resolves.toMatchObject({
        rows: [
          {
            attachment_source_message_id: "41",
            id: "00000000-0000-4000-8000-000000000001",
          },
          {
            attachment_source_message_id: null,
            id: "00000000-0000-4000-8000-000000000002",
          },
        ],
      });
      await expect(client.query(
        `UPDATE telegram_group_messages
            SET attachment_file_id = 'bad', attachment_source_message_id = 0
          WHERE id = '00000000-0000-4000-8000-000000000002'`,
      )).rejects.toThrow();
      await expect(client.query(
        `UPDATE telegram_group_messages
            SET attachment_source_message_id = 42
          WHERE id = '00000000-0000-4000-8000-000000000002'`,
      )).rejects.toThrow();
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
