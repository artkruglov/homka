/**
 * Unified Telegram group timeline migration integration test.
 *
 * Constructs covered:
 * - Migration 033 evolves persisted journal rows in place and preserves lazy attachments.
 * - Historical rows receive deterministic sequence IDs, aliases, replies, and a durable counter.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;
const TEST_SCHEMA = "test_unified_group_timeline_migration";

describeWithDatabase("033 unified Telegram group timeline migration", () => {
  afterAll(closeDatabase);

  it("preserves legacy rows and attachments while backfilling the monotonic timeline", async () => {
    const client = await database().connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      await client.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
      await client.query(`SET search_path TO ${TEST_SCHEMA}, public`);
      await client.query(`
        CREATE TABLE telegram_groups (
          id uuid PRIMARY KEY,
          family_id uuid NOT NULL,
          telegram_chat_id text NOT NULL
        );
        CREATE TABLE agent_schedules (
          id uuid PRIMARY KEY,
          message_thread_id bigint,
          telegram_chat_id text
        );
        CREATE TABLE reminders (
          id uuid PRIMARY KEY,
          message_thread_id bigint,
          telegram_chat_id text
        );
        CREATE TABLE telegram_ingress_updates (
          id uuid PRIMARY KEY,
          payload jsonb NOT NULL
        );
        CREATE TABLE telegram_group_messages (
          id uuid PRIMARY KEY,
          group_id uuid NOT NULL REFERENCES telegram_groups(id) ON DELETE CASCADE,
          telegram_message_id bigint NOT NULL,
          message_thread_id bigint,
          telegram_user_id text,
          sender_username text,
          sender_display_name text,
          sender_is_bot boolean NOT NULL,
          message_kind text NOT NULL,
          content_text text,
          reply_to_message_id bigint,
          sent_at timestamptz NOT NULL,
          received_at timestamptz NOT NULL DEFAULT now(),
          attachment_file_id text,
          attachment_file_unique_id text,
          attachment_file_name text,
          attachment_media_type text,
          attachment_size bigint,
          attachment_kind text,
          UNIQUE (group_id, telegram_message_id)
        );
        CREATE INDEX telegram_group_messages_context
          ON telegram_group_messages (group_id, message_thread_id, telegram_message_id DESC);
        CREATE INDEX telegram_group_messages_retention
          ON telegram_group_messages (group_id, telegram_message_id DESC);
      `);
      const groupId = "00000000-0000-4000-8000-000000000001";
      await client.query(
        `INSERT INTO telegram_groups (id, family_id, telegram_chat_id)
         VALUES ($1, '00000000-0000-4000-8000-000000000002', '-1001')`,
        [groupId],
      );
      await client.query(
        `INSERT INTO telegram_group_messages
           (id, group_id, telegram_message_id, telegram_user_id, sender_display_name,
            sender_is_bot, message_kind, content_text, reply_to_message_id, sent_at,
            attachment_file_id, attachment_kind)
         VALUES
           ('00000000-0000-4000-8000-000000000010', $1, 10, '101', 'Анна', false,
            'document', 'файл', NULL, '2026-07-28T10:00:00Z', 'secret-file-id', 'document'),
           ('00000000-0000-4000-8000-000000000011', $1, 11, '102', 'Пётр', false,
            'text', 'ответ', 10, '2026-07-28T10:01:00Z', NULL, NULL)`,
        [groupId],
      );

      const migration = await readFile(
        resolve("migrations/033_unified_telegram_group_timeline.sql"),
        "utf8",
      );
      await client.query(migration);

      const rows = await client.query<{
        actor_kind: string;
        attachment_file_id: string | null;
        reply_sequence: string | null;
        sequence_id: string;
      }>(
        `SELECT message.sequence_id::text, message.actor_kind, message.attachment_file_id,
                reply.sequence_id::text AS reply_sequence
         FROM telegram_group_messages message
         LEFT JOIN telegram_group_messages reply ON reply.id = message.reply_to_entry_id
         ORDER BY message.sequence_id`,
      );
      expect(rows.rows).toEqual([
        { actor_kind: "user", attachment_file_id: "secret-file-id", reply_sequence: null, sequence_id: "1" },
        { actor_kind: "user", attachment_file_id: null, reply_sequence: "1", sequence_id: "2" },
      ]);
      const state = await client.query<{ aliases: string; counter: string }>(
        `SELECT telegram_group.next_timeline_sequence::text AS counter,
                count(alias.*)::text AS aliases
         FROM telegram_groups telegram_group
         JOIN telegram_group_message_ids alias ON alias.group_id = telegram_group.id
         GROUP BY telegram_group.id`,
      );
      expect(state.rows[0]).toEqual({ aliases: "2", counter: "2" });
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
