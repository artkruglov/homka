/**
 * Authored skill grant repository integration tests.
 *
 * Constructs covered:
 * - Grant finds the family's external group by title or chat id, refuses a skill whose steps name
 *   a tool outside the group's allowlist, and is idempotent.
 * - Packages for the group follow the live allowlist: a revoked capability hides the skill again.
 * - Revoke removes the grant; a member of the family cannot grant.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import type { FamilyCaller } from "../family-context.js";
import { createMainAgentMemoryFixture } from "../memory-agent-write.integration-fixtures.js";
import { AUTHORED_SKILL_LIMITS } from "./authored-skill-contract.js";
import { authoredSkillGrantRepository } from "./authored-skill-grant-repository.js";
import { authoredSkillRepository } from "./authored-skill-repository.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;

const KNOWN = new Set(["web_search", "write_file", "send_workspace_file"]);
const provenance = { eveSessionId: "eve-grant-session", eveTurnId: "turn-grant" };

function draft(name: string, steps: string) {
  return {
    changeNote: "Первая версия",
    description: "Сводка недели по чату",
    files: {},
    markdown: ["## Когда применять", "Когда просят сводку.", "## Шаги", steps, "## Проверка результата", "Сводка короткая."].join("\n"),
    name,
    trialSummary: "Сделала одну сводку.",
  };
}

describeWithDatabase("authored skill grant repository", () => {
  let owner: FamilyCaller;
  let familyId: string;
  let groupId: string;

  beforeEach(async () => {
    await database().query("TRUNCATE users, families CASCADE");
    const fixture = await createMainAgentMemoryFixture();
    owner = { familyId: fixture.familyId, role: "owner", userId: fixture.userId };
    familyId = fixture.familyId;
    const group = await database().query<{ id: string }>(
      `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode, tool_allowlist)
       VALUES ($1, '-1001', 'Клуб бегунов', 'external', 'addressed_only', '{web_search}') RETURNING id`,
      [familyId],
    );
    groupId = group.rows[0]!.id;
    await authoredSkillRepository.publish(owner, draft("weekly-digest", "1. Вызови `web_search`.\n2. Запиши через `write_file`."), {
      knownToolNames: KNOWN, operationKey: "call-1", provenance,
    });
    await authoredSkillRepository.publish(owner, draft("send-card", "1. Отправь `send_workspace_file`."), {
      knownToolNames: KNOWN, operationKey: "call-2", provenance,
    });
  });

  afterAll(closeDatabase);

  it("grants by title or chat id, refuses uncovered steps and stays idempotent", async () => {
    await expect(authoredSkillGrantRepository.grant(owner, { group: "клуб бегунов", name: "weekly-digest" }))
      .resolves.toEqual({ granted: true, group: { telegramChatId: "-1001", title: "Клуб бегунов" }, name: "weekly-digest" });
    await expect(authoredSkillGrantRepository.grant(owner, { group: "-1001", name: "weekly-digest" }))
      .resolves.toMatchObject({ granted: false });
    await expect(authoredSkillGrantRepository.grant(owner, { group: "-1001", name: "send-card" }))
      .rejects.toMatchObject({ code: "AGENT_SKILL_GROUP_TOOLS_MISSING", message: expect.stringContaining("send_workspace_file") });
    await expect(authoredSkillGrantRepository.grant(owner, { group: "Семья", name: "weekly-digest" }))
      .rejects.toMatchObject({ code: "AGENT_SKILL_GROUP_NOT_FOUND" });
    await expect(authoredSkillGrantRepository.grant(owner, { group: "-1001", name: "missing" }))
      .rejects.toMatchObject({ code: "AGENT_SKILL_NOT_FOUND" });
    await expect(authoredSkillGrantRepository.grant({ ...owner, role: "member" }, { group: "-1001", name: "weekly-digest" }))
      .rejects.toMatchObject({ code: "AGENT_SKILL_FORBIDDEN" });

    await expect(authoredSkillGrantRepository.grants(familyId)).resolves.toEqual([
      { groupTitle: "Клуб бегунов", name: "weekly-digest", telegramChatId: "-1001" },
    ]);
  });

  it("caps the grants of one group", async () => {
    for (let index = 0; index < AUTHORED_SKILL_LIMITS.grantsPerGroup; index += 1) {
      const name = `digest-${index}`;
      await authoredSkillRepository.publish(owner, draft(name, "1. Вызови `web_search`."), {
        knownToolNames: KNOWN, operationKey: `call-cap-${index}`, provenance,
      });
      await authoredSkillGrantRepository.grant(owner, { group: "-1001", name });
    }
    await expect(authoredSkillGrantRepository.grant(owner, { group: "-1001", name: "weekly-digest" }))
      .rejects.toMatchObject({ code: "AGENT_SKILL_GRANT_LIMIT_REACHED" });
    // Re-granting an already granted skill is not a new grant and stays allowed.
    await expect(authoredSkillGrantRepository.grant(owner, { group: "-1001", name: "digest-0" }))
      .resolves.toMatchObject({ granted: false });
  });

  it("serves packages only while the allowlist covers the steps and until revoked", async () => {
    await authoredSkillGrantRepository.grant(owner, { group: "-1001", name: "weekly-digest" });
    const identity = { familyId, groupId };

    await expect(authoredSkillGrantRepository.packagesForGroup(identity))
      .resolves.toEqual([expect.objectContaining({ description: "Сводка недели по чату", name: "weekly-digest" })]);
    await expect(authoredSkillGrantRepository.grantedMarkdown({ ...identity, name: "weekly-digest" }))
      .resolves.toContain("`web_search`");
    await expect(authoredSkillGrantRepository.grantedMarkdown({ ...identity, name: "send-card" })).resolves.toBeNull();
    await expect(authoredSkillGrantRepository.groupConversationId(groupId)).resolves.toEqual(expect.any(String));

    // The owner revokes web_search from the group: the skill's steps are no longer covered.
    await database().query("UPDATE telegram_groups SET tool_allowlist = '{}' WHERE id = $1", [groupId]);
    await expect(authoredSkillGrantRepository.packagesForGroup(identity)).resolves.toEqual([]);
    await database().query("UPDATE telegram_groups SET tool_allowlist = '{web_search}' WHERE id = $1", [groupId]);

    await expect(authoredSkillGrantRepository.revoke(owner, { group: "Клуб бегунов", name: "weekly-digest" }))
      .resolves.toEqual({ group: { telegramChatId: "-1001", title: "Клуб бегунов" }, name: "weekly-digest" });
    await expect(authoredSkillGrantRepository.revoke(owner, { group: "Клуб бегунов", name: "weekly-digest" }))
      .rejects.toMatchObject({ code: "AGENT_SKILL_GRANT_NOT_FOUND" });
    await expect(authoredSkillGrantRepository.packagesForGroup(identity)).resolves.toEqual([]);

    // A retired skill's grant goes inert.
    await authoredSkillGrantRepository.grant(owner, { group: "-1001", name: "weekly-digest" });
    await authoredSkillRepository.retire(owner, { name: "weekly-digest" });
    await expect(authoredSkillGrantRepository.packagesForGroup(identity)).resolves.toEqual([]);
    await expect(authoredSkillGrantRepository.grants(familyId)).resolves.toEqual([]);
  });
});
