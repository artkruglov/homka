/** PostgreSQL boundary for the removed custom-group-skill feature. */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const describeWithDatabase = enabled ? describe : describe.skip;

describeWithDatabase("removed Telegram group skill policy", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE telegram_groups, families CASCADE");
  });
  afterAll(closeDatabase);

  it("allows only an empty legacy allowlist", async () => {
    const family = await database().query<{ id: string }>(
      "INSERT INTO families (name) VALUES ('No custom skills') RETURNING id",
    );
    const group = await database().query<{ id: string }>(
      `INSERT INTO telegram_groups
         (family_id, telegram_chat_id, title, type, message_mode, skill_allowlist)
       VALUES ($1, '-1004401', 'External', 'external', 'addressed_only', '{}')
       RETURNING id`,
      [family.rows[0]!.id],
    );

    await expect(database().query(
      "UPDATE telegram_groups SET skill_allowlist = ARRAY['removed-skill'] WHERE id = $1",
      [group.rows[0]!.id],
    )).rejects.toThrow();
    await expect(database().query<{ skill_allowlist: string[] }>(
      "SELECT skill_allowlist FROM telegram_groups WHERE id = $1",
      [group.rows[0]!.id],
    )).resolves.toMatchObject({ rows: [{ skill_allowlist: [] }] });
  });
});
