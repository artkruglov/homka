/**
 * PostgreSQL family attachment read pagination tests.
 *
 * Constructs covered:
 * - Stable topic-confined cursor pagination beyond the first bounded page.
 * - Exact filename filtering and fail-fast malformed cursor rejection.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { telegramGroupAttachmentRepository } from "./telegram-group-attachment-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const describeWithDatabase = enabled ? describe : describe.skip;

describeWithDatabase("Telegram attachment read pagination", () => {
  beforeEach(async () => {
    await database().query(
      "TRUNCATE telegram_group_messages, telegram_groups, family_memberships, users, families CASCADE",
    );
  });
  afterAll(async () => closeDatabase());

  it("reaches an old exact-name attachment without duplicates or topic leakage", async () => {
    const family = await database().query<{ id: string }>(
      "INSERT INTO families (name) VALUES ('Вложения') RETURNING id",
    );
    const user = await database().query<{ id: string }>(
      "INSERT INTO users (telegram_user_id, display_name) VALUES ('attachment-owner', 'Владелец') RETURNING id",
    );
    await database().query(
      "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')",
      [family.rows[0]!.id, user.rows[0]!.id],
    );
    const group = await database().query<{ id: string }>(
      `INSERT INTO telegram_groups
         (family_id, telegram_chat_id, title, type, message_mode, next_timeline_sequence)
       VALUES ($1, '-100-attachments', 'Семья', 'family_private', 'addressed_only', 53)
       RETURNING id`,
      [family.rows[0]!.id],
    );
    await database().query(
      `INSERT INTO telegram_group_messages
         (group_id, telegram_message_id, message_thread_id, sender_is_bot, message_kind,
          content_text, sent_at, sequence_id, actor_kind, actor_id, attachment_file_id,
          attachment_file_name, attachment_kind, attachment_source_message_id)
       SELECT $1, item, CASE WHEN item = 52 THEN 78 ELSE 77 END, false, 'document',
              'Документ ' || item, timestamptz '2026-01-01 00:00:00+00' + item * interval '1 minute',
              item, 'user', 'telegram:attachment-owner', 'file-' || item,
              CASE WHEN item = 1 THEN 'нужный.pdf' WHEN item = 2 THEN 'Нужный.pdf' ELSE 'файл-' || item || '.pdf' END,
              'document', item
         FROM generate_series(1, 52) AS item`,
      [group.rows[0]!.id],
    );
    const auth = {
      familyId: family.rows[0]!.id,
      groupId: group.rows[0]!.id,
      groupType: "family_private" as const,
      role: "owner" as const,
      telegramChatType: "supergroup" as const,
      userId: user.rows[0]!.id,
    };

    const first = await telegramGroupAttachmentRepository.list(auth, {
      limit: 50,
      messageThreadId: "77",
    });
    const second = await telegramGroupAttachmentRepository.list(auth, {
      cursor: first.nextCursor!,
      limit: 50,
      messageThreadId: "77",
    });
    const exact = await telegramGroupAttachmentRepository.list(auth, {
      fileName: "нужный.pdf",
      limit: 50,
      messageThreadId: "77",
    });
    const ids = [...first.items, ...second.items].map((item) => item.attachmentId);

    expect(first.items).toHaveLength(50);
    expect(second.items).toHaveLength(1);
    expect(new Set(ids)).toHaveLength(51);
    expect(exact.items).toHaveLength(1);
    expect(exact.items[0]).toMatchObject({ fileName: "нужный.pdf", telegramMessageId: "1" });
    await expect(telegramGroupAttachmentRepository.list(auth, {
      cursor: "invalid",
      limit: 50,
      messageThreadId: "77",
    })).rejects.toMatchObject({ code: "AGENT_TELEGRAM_ATTACHMENT_CURSOR_INVALID" });
  });
});
