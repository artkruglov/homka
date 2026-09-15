/**
 * Telegram owner-only message-mode migration tests.
 *
 * Constructs covered:
 * - PostgreSQL accepts owner-only dispatch for external trust zones.
 * - PostgreSQL rejects owner-only dispatch for family trust zones even outside application code.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const describeWithDatabase = enabled ? describe : describe.skip;

describeWithDatabase("Telegram owner-only message mode", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE telegram_groups, families CASCADE");
  });
  afterAll(async () => closeDatabase());

  it("persists owner-only mode only for an external trust zone", async () => {
    const family = await database().query<{ id: string }>(
      "INSERT INTO families (name) VALUES ('Owner only') RETURNING id",
    );

    await expect(database().query(
      `INSERT INTO telegram_groups
         (family_id, telegram_chat_id, title, type, message_mode)
       VALUES ($1, '-100-owner-only-external', 'External', 'external', 'owner_only')`,
      [family.rows[0]!.id],
    )).resolves.toMatchObject({ rowCount: 1 });

    await expect(database().query(
      `INSERT INTO telegram_groups
         (family_id, telegram_chat_id, title, type, message_mode)
       VALUES ($1, '-100-owner-only-family', 'Family', 'family_private', 'owner_only')`,
      [family.rows[0]!.id],
    )).rejects.toMatchObject({
      constraint: "telegram_groups_owner_only_external",
    });
  });
});
