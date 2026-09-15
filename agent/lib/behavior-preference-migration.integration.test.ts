/**
 * Migration 071 chat communication preference cutover tests.
 *
 * Constructs covered:
 * - Legacy personal, family, and group settings become one text prompt per exact conversation.
 * - Family defaults preserve their former private/family reach without leaking to external groups.
 * - Personal precedence is rendered into the same prompt and the scope-based table is removed.
 */
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";

const integrationTestsEnabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const integrationDatabaseUrl = process.env.DATABASE_URL;

// Migration tests destroy an isolated schema and must never run against a production database.
if (integrationTestsEnabled) {
  if (!integrationDatabaseUrl) {
    throw new Error("AGENT_TEST_DATABASE_CONFIG_MISSING: Для integration-тестов не задан DATABASE_URL");
  }
  if (!new URL(integrationDatabaseUrl).pathname.slice(1).endsWith("_test")) {
    throw new Error(
      "AGENT_TEST_DATABASE_UNSAFE: Integration-тесты разрешены только для БД с суффиксом _test",
    );
  }
}
const describeWithDatabase = integrationTestsEnabled ? describe : describe.skip;
const MIGRATION_NAME = "071_chat_communication_preferences.sql";
const MIGRATION_ORDINAL = 71;
const TEST_SCHEMA = "test_chat_communication_preferences";
const MIGRATION_NAME_PATTERN = /^(\d+)_.*\.sql$/u;

function migrationOrdinal(name: string): number | null {
  const match = MIGRATION_NAME_PATTERN.exec(name);
  return match ? Number.parseInt(match[1]!, 10) : null;
}

async function applyMigrationsBefore071(client: import("pg").PoolClient): Promise<void> {
  const names = (await readdir(resolve("migrations")))
    .filter((name) => {
      const ordinal = migrationOrdinal(name);
      return ordinal !== null && ordinal < MIGRATION_ORDINAL;
    })
    .sort((left, right) => {
      const difference = migrationOrdinal(left)! - migrationOrdinal(right)!;
      return difference || left.localeCompare(right);
    });
  for (const name of names) {
    await client.query(await readFile(resolve("migrations", name), "utf8"));
  }
}

describeWithDatabase("071 chat communication preferences migration", () => {
  afterAll(closeDatabase);

  it("projects every legacy scope to exact chats without external leakage", async () => {
    const client = await database().connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      await client.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
      await client.query(`SET search_path TO ${TEST_SCHEMA}, public`);
      await applyMigrationsBefore071(client);

      const family = await client.query<{ id: string }>(
        "INSERT INTO families (name) VALUES ('Preference migration') RETURNING id",
      );
      const users = await client.query<{ id: string; telegram_user_id: string }>(
        `INSERT INTO users (telegram_user_id, display_name)
         VALUES ('migration-owner', 'Owner'), ('migration-member', 'Member')
         RETURNING id, telegram_user_id`,
      );
      const owner = users.rows.find((row) => row.telegram_user_id === "migration-owner")!;
      const member = users.rows.find((row) => row.telegram_user_id === "migration-member")!;
      await client.query(
        `INSERT INTO family_memberships (family_id, user_id, role)
         VALUES ($1, $2, 'owner'), ($1, $3, 'member')`,
        [family.rows[0]!.id, owner.id, member.id],
      );
      const groups = await client.query<{ id: string; type: "external" | "family_private" }>(
        `INSERT INTO telegram_groups
           (family_id, telegram_chat_id, title, type, message_mode)
         VALUES ($1, '-100-migration-family', 'Family', 'family_private', 'all'),
                ($1, '-100-migration-external', 'External', 'external', 'all')
         RETURNING id, type`,
        [family.rows[0]!.id],
      );
      const externalGroup = groups.rows.find((row) => row.type === "external")!;
      await client.query(
        `INSERT INTO behavior_preferences
           (family_id, owner_user_id, group_id, scope, preference, value)
         VALUES ($1, $2, NULL, 'personal', 'tone', 'warm'),
                ($1, NULL, NULL, 'family', 'response_length', 'concise'),
                ($1, NULL, $3, 'group', 'status_updates', 'minimal')`,
        [family.rows[0]!.id, owner.id, externalGroup.id],
      );

      await client.query(await readFile(resolve("migrations", MIGRATION_NAME), "utf8"));

      const projected = await client.query<{
        content: string;
        revision: number;
        scope: "family" | "group" | "personal";
        source_sequence: string;
      }>(
        `SELECT prompt.content, prompt.revision, conversation.scope,
                prompt.last_source_sequence::text AS source_sequence
         FROM behavior_preferences AS prompt
         JOIN application_conversations AS conversation ON conversation.id = prompt.conversation_id
         ORDER BY conversation.scope, conversation.telegram_chat_id`,
      );
      expect(projected.rows).toHaveLength(4);
      expect(projected.rows.filter((row) => row.scope !== "group").every(
        (row) => row.content.includes("Отвечай кратко"),
      )).toBe(true);
      const ownerPrompt = projected.rows.find(
        (row) => row.scope === "personal" && row.content.includes("тёплый"),
      );
      expect(ownerPrompt).toMatchObject({ revision: 1, source_sequence: "-1" });
      expect(projected.rows.find((row) => row.scope === "group")).toMatchObject({
        content: "Не отправляй промежуточные статусы, кроме реальной задержки или блокировки.",
        revision: 1,
        source_sequence: "-1",
      });
      const oldColumn = await client.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'behavior_preferences' AND column_name = 'scope'`,
        [TEST_SCHEMA],
      );
      expect(oldColumn.rowCount).toBe(0);
    } finally {
      await client.query("SET search_path TO public");
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      client.release();
    }
  });

  it("rolls the cutover back when a legacy value has no explicit rendering", async () => {
    const client = await database().connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      await client.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
      await client.query(`SET search_path TO ${TEST_SCHEMA}, public`);
      await applyMigrationsBefore071(client);
      const family = await client.query<{ id: string }>(
        "INSERT INTO families (name) VALUES ('Invalid preference migration') RETURNING id",
      );
      const owner = await client.query<{ id: string }>(
        `INSERT INTO users (telegram_user_id, display_name)
         VALUES ('invalid-migration-owner', 'Owner') RETURNING id`,
      );
      await client.query(
        "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')",
        [family.rows[0]!.id, owner.rows[0]!.id],
      );
      await client.query(
        `INSERT INTO behavior_preferences
           (family_id, owner_user_id, group_id, scope, preference, value)
         VALUES ($1, $2, NULL, 'personal', 'tone', 'unknown-tone')`,
        [family.rows[0]!.id, owner.rows[0]!.id],
      );

      await expect(client.query(
        await readFile(resolve("migrations", MIGRATION_NAME), "utf8"),
      )).rejects.toThrowError(/AGENT_BEHAVIOR_PREFERENCE_MIGRATION_UNMAPPED/u);
      const legacyColumn = await client.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'behavior_preferences' AND column_name = 'scope'`,
        [TEST_SCHEMA],
      );
      expect(legacyColumn.rowCount).toBe(1);
    } finally {
      await client.query("SET search_path TO public");
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      client.release();
    }
  });

  it("identifies a legacy preference that has no target conversation", async () => {
    const client = await database().connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      await client.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
      await client.query(`SET search_path TO ${TEST_SCHEMA}, public`);
      await applyMigrationsBefore071(client);
      const family = await client.query<{ id: string }>(
        "INSERT INTO families (name) VALUES ('Unmapped preference migration') RETURNING id",
      );
      await client.query(
        `INSERT INTO behavior_preferences
           (family_id, owner_user_id, group_id, scope, preference, value)
         VALUES ($1, NULL, NULL, 'family', 'tone', 'neutral')`,
        [family.rows[0]!.id],
      );

      await expect(client.query(
        await readFile(resolve("migrations", MIGRATION_NAME), "utf8"),
      )).rejects.toThrowError(
        new RegExp(
          `AGENT_BEHAVIOR_PREFERENCE_MIGRATION_UNMAPPED:.*${family.rows[0]!.id}.*family.*tone`,
          "u",
        ),
      );
    } finally {
      await client.query("SET search_path TO public");
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      client.release();
    }
  });
});
