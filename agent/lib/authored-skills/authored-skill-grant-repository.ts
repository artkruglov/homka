/**
 * Grants of authored skills to external groups.
 *
 * Exports:
 * - `authoredSkillGrantRepository`: `grant` / `revoke` (owner, by group title or chat id),
 *   `grants` for the library listing, `packagesForGroup` for the external resolver,
 *   `grantedMarkdown` for the live `load_skill` check, `groupConversationId` for usage rows.
 *
 * Key constructs:
 * - A skill adds procedure, never rights: `grant` refuses a skill whose steps name a tool the
 *   group's allowlist does not carry, and every later read re-applies the same check against the
 *   allowlist of that moment, so a revoked capability silently closes the skill.
 * - Grants hang on the skill row: a retired skill's grants go inert, a re-published one starts clean.
 */
import { AppError } from "../app-error.js";
import { database } from "../database.js";
import type { FamilyCaller } from "../family-context.js";
import { AUTHORED_SKILL_LIMITS, externalGroupMissingTools } from "./authored-skill-contract.js";
import { requireCurrentOwner } from "./authored-skill-owner.js";
import type { AuthoredSkillPackage } from "./authored-skill-repository.js";

export interface AuthoredSkillGrant {
  groupTitle: string;
  name: string;
  telegramChatId: string;
}

interface GroupRow {
  id: string;
  telegram_chat_id: string;
  title: string;
  tool_allowlist: string[];
}

interface PackageRow extends AuthoredSkillPackage {
  tool_allowlist: string[];
}

/** The family's external group named by exact chat id or case-insensitive title. */
async function findExternalGroup(familyId: string, group: string): Promise<GroupRow> {
  const result = await database().query<GroupRow>(
    `SELECT id, telegram_chat_id, title, tool_allowlist FROM telegram_groups
      WHERE family_id = $1 AND type = 'external'
        AND (telegram_chat_id = $2 OR lower(title) = lower($2))
      ORDER BY telegram_chat_id`,
    [familyId, group.trim()],
  );
  if (result.rows.length === 0) {
    throw new AppError("AGENT_SKILL_GROUP_NOT_FOUND", `Внешней группы «${group}» у семьи нет; проверь status в manage_telegram_group`);
  }
  if (result.rows.length > 1) {
    const ids = result.rows.map((row) => row.telegram_chat_id).join(", ");
    throw new AppError("AGENT_SKILL_GROUP_AMBIGUOUS", `Под названием «${group}» несколько групп; укажи chat id: ${ids}`);
  }
  return result.rows[0]!;
}

function requireCoveredTools(name: string, markdown: string, allowed: ReadonlySet<string>): void {
  const missing = externalGroupMissingTools(markdown, allowed);
  if (missing.length > 0) {
    throw new AppError(
      "AGENT_SKILL_GROUP_TOOLS_MISSING",
      `Навык ${name} использует инструменты, не выданные этой группе: ${missing.join(", ")}. Сначала выдай их через manage_telegram_group или перепиши шаги`,
    );
  }
}

export const authoredSkillGrantRepository = {
  async grant(caller: FamilyCaller, input: { group: string; name: string }): Promise<{
    granted: boolean;
    group: { telegramChatId: string; title: string };
    name: string;
  }> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      await requireCurrentOwner(client, caller);
      const group = await findExternalGroup(caller.familyId, input.group);
      const skill = await client.query<{ id: string; markdown: string }>(
        "SELECT id, markdown FROM authored_skills WHERE family_id = $1 AND name = $2 AND status = 'active'",
        [caller.familyId, input.name],
      );
      const row = skill.rows[0];
      if (!row) throw new AppError("AGENT_SKILL_NOT_FOUND", `Навыка ${input.name} нет среди активных`);
      requireCoveredTools(input.name, row.markdown, new Set(group.tool_allowlist));
      const existing = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM authored_skill_group_grants AS grant_row
           JOIN authored_skills AS skill ON skill.id = grant_row.skill_id
          WHERE grant_row.group_id = $1 AND skill.status = 'active' AND skill.id <> $2`,
        [group.id, row.id],
      );
      if (Number(existing.rows[0]!.count) >= AUTHORED_SKILL_LIMITS.grantsPerGroup) {
        throw new AppError(
          "AGENT_SKILL_GRANT_LIMIT_REACHED",
          `У группы уже ${AUTHORED_SKILL_LIMITS.grantsPerGroup} навыков; сначала забери ненужный через revoke`,
        );
      }
      const inserted = await client.query(
        `INSERT INTO authored_skill_group_grants (skill_id, group_id, family_id, granted_by_user_id)
         VALUES ($1, $2, $3, $4) ON CONFLICT (skill_id, group_id) DO NOTHING`,
        [row.id, group.id, caller.familyId, caller.userId],
      );
      await client.query("COMMIT");
      const granted = (inserted.rowCount ?? 0) > 0;
      console.info(JSON.stringify({
        code: "AGENT_SKILL_GRANTED", familyId: caller.familyId, granted, groupId: group.id, name: input.name,
      }));
      return { granted, group: { telegramChatId: group.telegram_chat_id, title: group.title }, name: input.name };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async revoke(caller: FamilyCaller, input: { group: string; name: string }): Promise<{
    group: { telegramChatId: string; title: string };
    name: string;
  }> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      await requireCurrentOwner(client, caller);
      const group = await findExternalGroup(caller.familyId, input.group);
      const deleted = await client.query(
        `DELETE FROM authored_skill_group_grants AS grant_row
          USING authored_skills AS skill
          WHERE skill.id = grant_row.skill_id AND grant_row.group_id = $2
            AND skill.family_id = $1 AND skill.name = $3`,
        [caller.familyId, group.id, input.name],
      );
      if ((deleted.rowCount ?? 0) === 0) {
        throw new AppError("AGENT_SKILL_GRANT_NOT_FOUND", `Навык ${input.name} этой группе не выдавался`);
      }
      await client.query("COMMIT");
      console.info(JSON.stringify({ code: "AGENT_SKILL_REVOKED", familyId: caller.familyId, groupId: group.id, name: input.name }));
      return { group: { telegramChatId: group.telegram_chat_id, title: group.title }, name: input.name };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  /** Grants of the family's active skills, for the library listing. */
  async grants(familyId: string): Promise<AuthoredSkillGrant[]> {
    const result = await database().query<{ name: string; telegram_chat_id: string; title: string }>(
      `SELECT skill.name, telegram_group.title, telegram_group.telegram_chat_id
         FROM authored_skill_group_grants AS grant_row
         JOIN authored_skills AS skill ON skill.id = grant_row.skill_id
         JOIN telegram_groups AS telegram_group ON telegram_group.id = grant_row.group_id
        WHERE grant_row.family_id = $1 AND skill.status = 'active'
        ORDER BY skill.name, lower(telegram_group.title)`,
      [familyId],
    );
    return result.rows.map((row) => ({ groupTitle: row.title, name: row.name, telegramChatId: row.telegram_chat_id }));
  },

  /** Active granted skills whose steps the group's current allowlist covers. */
  async packagesForGroup(input: { familyId: string; groupId: string }): Promise<AuthoredSkillPackage[]> {
    const result = await database().query<PackageRow>(
      `SELECT skill.name, skill.description, skill.markdown, skill.files, telegram_group.tool_allowlist
         FROM authored_skill_group_grants AS grant_row
         JOIN authored_skills AS skill ON skill.id = grant_row.skill_id
         JOIN telegram_groups AS telegram_group ON telegram_group.id = grant_row.group_id
        WHERE grant_row.group_id = $1 AND grant_row.family_id = $2
          AND telegram_group.family_id = $2 AND telegram_group.type = 'external'
          AND skill.status = 'active'
        ORDER BY skill.name`,
      [input.groupId, input.familyId],
    );
    return result.rows
      .filter((row) => externalGroupMissingTools(row.markdown, new Set(row.tool_allowlist)).length === 0)
      .map((row) => ({ description: row.description, files: row.files, markdown: row.markdown, name: row.name }));
  },

  /** Markdown of the granted active skill, or null when the group holds no such grant. */
  async grantedMarkdown(input: { familyId: string; groupId: string; name: string }): Promise<string | null> {
    const result = await database().query<{ markdown: string }>(
      `SELECT skill.markdown
         FROM authored_skill_group_grants AS grant_row
         JOIN authored_skills AS skill ON skill.id = grant_row.skill_id
        WHERE grant_row.group_id = $1 AND grant_row.family_id = $2
          AND skill.name = $3 AND skill.status = 'active'`,
      [input.groupId, input.familyId, input.name],
    );
    return result.rows[0]?.markdown ?? null;
  },

  /** Application conversation of a registered group, for usage rows and outcomes. */
  async groupConversationId(groupId: string): Promise<string | null> {
    const result = await database().query<{ id: string }>(
      "SELECT id FROM application_conversations WHERE telegram_group_id = $1",
      [groupId],
    );
    return result.rows[0]?.id ?? null;
  },
};
