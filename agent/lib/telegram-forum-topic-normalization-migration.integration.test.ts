/**
 * Historical Telegram forum-topic normalization migration test.
 *
 * Constructs covered:
 * - Migration 032 normalizes a reply thread only when its durable payload proves it is not a topic.
 * - Verified forum-topic rows and rows without durable evidence remain isolated.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";

const integrationTestsEnabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const describeWithDatabase = integrationTestsEnabled ? describe : describe.skip;

describeWithDatabase("032 Telegram forum topic normalization migration", () => {
  beforeEach(async () => {
    await database().query(
      `TRUNCATE telegram_ingress_updates, telegram_ingress_continuation_aliases,
         telegram_ingress_queues, telegram_group_messages, telegram_groups,
         family_memberships, users, families CASCADE`,
    );
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("normalizes only a historical reply thread proven not to be a forum topic", async () => {
    const family = await database().query<{ id: string }>(
      "INSERT INTO families (name) VALUES ('Семья migration 032') RETURNING id",
    );
    const group = await database().query<{ id: string }>(
      `INSERT INTO telegram_groups
         (family_id, telegram_chat_id, title, type, tool_allowlist, message_mode)
       VALUES ($1, '-1001', 'Группа', 'family_private', '{}', 'all')
       RETURNING id`,
      [family.rows[0]!.id],
    );
    await database().query(
       `INSERT INTO telegram_group_messages
          (group_id, sequence_id, actor_kind, actor_id, telegram_message_id,
           message_thread_id, telegram_user_id, sender_is_bot, message_kind, content_text, sent_at)
        VALUES
          ($1, 1, 'user', 'telegram:101', 30, 310, '101', false, 'text', 'обычная reply-ветка', now()),
          ($1, 2, 'user', 'telegram:101', 31, 311, '101', false, 'text', 'настоящая тема', now()),
          ($1, 3, 'user', 'telegram:101', 32, 312, '101', false, 'text', 'нет durable evidence', now())`,
      [group.rows[0]!.id],
    );
    const queue = await database().query<{ id: string }>(
      `INSERT INTO telegram_ingress_queues (current_continuation_key)
       VALUES ('migration-032') RETURNING id`,
    );
    await database().query(
      `INSERT INTO telegram_ingress_updates
         (update_id, queue_id, ingress_continuation_key, payload)
       VALUES
         (320030, $1, 'migration-032', $2::jsonb),
         (320031, $1, 'migration-032', $3::jsonb)`,
      [
        queue.rows[0]!.id,
        JSON.stringify({ message: { chat: { id: -1001 }, message_id: 30 } }),
        JSON.stringify({
          message: { chat: { id: -1001 }, is_topic_message: true, message_id: 31 },
        }),
      ],
    );

    const migration = await readFile(
      resolve("migrations/032_normalize_group_journal_forum_topics.sql"),
      "utf8",
    );
    await database().query(migration);

    const rows = await database().query<{
      message_thread_id: string | null;
      telegram_message_id: string;
    }>(
      `SELECT telegram_message_id::text, message_thread_id::text
       FROM telegram_group_messages
       WHERE group_id = $1 ORDER BY telegram_message_id`,
      [group.rows[0]!.id],
    );
    expect(rows.rows).toEqual([
      { message_thread_id: null, telegram_message_id: "30" },
      { message_thread_id: "311", telegram_message_id: "31" },
      { message_thread_id: "312", telegram_message_id: "32" },
    ]);
  });
});
