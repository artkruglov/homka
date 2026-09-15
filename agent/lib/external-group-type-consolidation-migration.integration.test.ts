/**
 * External Telegram group type consolidation migration integration test.
 *
 * Constructs covered:
 * - Migration 041 maps both historical external types to the canonical `external` enum value.
 * - Existing group IDs, configuration, message modes, data, and foreign-key relationships survive.
 * - The resulting enum and database constraints accept only `family_private` and `external`.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;
const TEST_SCHEMA = "test_external_group_type_consolidation";

describeWithDatabase("041 external Telegram group type consolidation migration", () => {
  afterAll(closeDatabase);

  it("preserves external group identities, policies, data, and foreign keys", async () => {
    const client = await database().connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      await client.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
      await client.query(`SET search_path TO ${TEST_SCHEMA}, public`);

      // Reproduce the exact enum values and type-dependent constraints before migration 041.
      await client.query(`
        CREATE TYPE telegram_group_type AS ENUM (
          'family_private',
          'external_private',
          'external_public'
        );
        CREATE TYPE telegram_group_message_mode AS ENUM ('addressed_only', 'all', 'owner_only');
        CREATE TABLE telegram_groups (
          id uuid PRIMARY KEY,
          family_id uuid NOT NULL,
          telegram_chat_id text NOT NULL UNIQUE,
          title text NOT NULL,
          type telegram_group_type NOT NULL,
          message_mode telegram_group_message_mode NOT NULL,
          tool_allowlist text[] NOT NULL,
          config jsonb NOT NULL,
          CONSTRAINT telegram_groups_family_allowlist_empty
            CHECK (type <> 'family_private' OR cardinality(tool_allowlist) = 0),
          CONSTRAINT telegram_groups_owner_only_external
            CHECK (message_mode <> 'owner_only' OR type IN ('external_private', 'external_public'))
        );
        CREATE TABLE telegram_group_data (
          id uuid PRIMARY KEY,
          group_id uuid NOT NULL REFERENCES telegram_groups(id) ON DELETE CASCADE,
          payload jsonb NOT NULL
        );
      `);

      // Distinct historical values and policies ensure the migration does not normalize other data.
      await client.query(`
        INSERT INTO telegram_groups
          (id, family_id, telegram_chat_id, title, type, message_mode, tool_allowlist, config)
        VALUES
          ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000010',
           '-1001', 'Private external', 'external_private', 'addressed_only', ARRAY['remember'],
           '{"visibility":"private","limit":7}'),
          ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000010',
           '-1002', 'Public external', 'external_public', 'owner_only', ARRAY['search_memories'],
           '{"visibility":"public","limit":9}'),
          ('00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000010',
           '-1003', 'Family', 'family_private', 'all', '{}', '{"trusted":true}');
        INSERT INTO telegram_group_data (id, group_id, payload)
        VALUES
          ('00000000-0000-4000-8000-000000000101',
           '00000000-0000-4000-8000-000000000001', '{"kind":"timeline","sequence":11}'),
          ('00000000-0000-4000-8000-000000000102',
           '00000000-0000-4000-8000-000000000002', '{"kind":"memory","content":"kept"}');
      `);

      const migration = await readFile(
        resolve("migrations/041_consolidate_external_group_type.sql"),
        "utf8",
      );
      await client.query(migration);

      // Primary keys and every non-type field remain byte-for-byte attached to the same rows.
      const groups = await client.query(`
        SELECT id::text, telegram_chat_id, title, type::text, message_mode::text,
               tool_allowlist, config
        FROM telegram_groups
        ORDER BY telegram_chat_id
      `);
      expect(groups.rows).toEqual([
        {
          config: { limit: 7, visibility: "private" },
          id: "00000000-0000-4000-8000-000000000001",
          message_mode: "addressed_only",
          telegram_chat_id: "-1001",
          title: "Private external",
          tool_allowlist: ["remember"],
          type: "external",
        },
        {
          config: { limit: 9, visibility: "public" },
          id: "00000000-0000-4000-8000-000000000002",
          message_mode: "owner_only",
          telegram_chat_id: "-1002",
          title: "Public external",
          tool_allowlist: ["search_memories"],
          type: "external",
        },
        {
          config: { trusted: true },
          id: "00000000-0000-4000-8000-000000000003",
          message_mode: "all",
          telegram_chat_id: "-1003",
          title: "Family",
          tool_allowlist: [],
          type: "family_private",
        },
      ]);

      // Child IDs and FK targets prove that no delete/reinsert or trust-zone cascade occurred.
      const data = await client.query(`
        SELECT id::text, group_id::text, payload
        FROM telegram_group_data
        ORDER BY id
      `);
      expect(data.rows).toEqual([
        {
          group_id: "00000000-0000-4000-8000-000000000001",
          id: "00000000-0000-4000-8000-000000000101",
          payload: { kind: "timeline", sequence: 11 },
        },
        {
          group_id: "00000000-0000-4000-8000-000000000002",
          id: "00000000-0000-4000-8000-000000000102",
          payload: { content: "kept", kind: "memory" },
        },
      ]);

      const enumValues = await client.query<{ enumlabel: string }>(`
        SELECT enumlabel
        FROM pg_enum
        WHERE enumtypid = 'telegram_group_type'::regtype
        ORDER BY enumsortorder
      `);
      expect(enumValues.rows.map((row) => row.enumlabel)).toEqual(["family_private", "external"]);
      await expect(client.query(`
        INSERT INTO telegram_groups
          (id, family_id, telegram_chat_id, title, type, message_mode, tool_allowlist, config)
        VALUES
          (gen_random_uuid(), gen_random_uuid(), '-1004', 'Invalid family mode',
           'family_private', 'owner_only', '{}', '{}')
      `)).rejects.toThrow();
    } finally {
      // Pool connections must never retain a test schema after that schema is removed.
      try {
        await client.query("RESET search_path");
        await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      } finally {
        client.release();
      }
    }
  });
});
