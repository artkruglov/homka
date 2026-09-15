/**
 * Authored skill persistence: one family library, versions that never disappear, usage outcomes.
 *
 * Exports:
 * - `AuthoredSkillSummary`, `AuthoredSkillContent`, `AuthoredSkillPackage`: read models.
 * - `authoredSkillRepository`: publish / rollback / retire (owner, replay-safe), list / read,
 *   `activePackages` for the Eve resolver, `recordUsage` / `recordOutcome` / `isAuthoredSkill` for
 *   the feedback loop.
 *
 * Key constructs:
 * - Every mutation re-reads the owner role from `family_memberships` inside the transaction; the
 *   caller's role attribute is only a precondition.
 * - `operationKey` (the Eve tool call id) is unique per family among versions, so a replayed
 *   approved call returns the version it already created instead of creating another.
 * - Rollback and retire are new versions or a status flip; rows are never deleted.
 * - Version 2 and later pass the eval gate of `authored-skill-example-repository.ts`: every stored
 *   example rerun, the reruns saved with the version; the publish's own trial becomes an example.
 */
import type { PoolClient } from "pg";

import { AppError } from "../app-error.js";
import { database } from "../database.js";
import type { FamilyCaller } from "../family-context.js";
import {
  AUTHORED_SKILL_LIMITS,
  assertAuthoredSkillDraft,
  assertStoredSkillContent,
  type AuthoredSkillDraft,
} from "./authored-skill-contract.js";
import {
  activeExamples,
  insertExample,
  requireTrials,
  type AuthoredSkillExample,
  type AuthoredSkillTrial,
} from "./authored-skill-example-repository.js";
import { requireCurrentOwner } from "./authored-skill-owner.js";

export type AuthoredSkillOutcome = "failed" | "ok" | "unknown";

export interface AuthoredSkillSummary {
  description: string;
  lastOutcome: AuthoredSkillOutcome | null;
  name: string;
  status: "active" | "retired";
  updatedAt: string;
  usageCount: number;
  version: number;
}

export interface AuthoredSkillContent extends AuthoredSkillSummary {
  changeNote: string;
  /** Active examples of the skill; every one of them must be rerun before the next version. */
  examples: AuthoredSkillExample[];
  files: Readonly<Record<string, string>>;
  markdown: string;
  /** Reruns recorded with the version being read. */
  trials: AuthoredSkillTrial[];
  trialSummary: string;
}

export interface AuthoredSkillPackage {
  description: string;
  files: Readonly<Record<string, string>>;
  markdown: string;
  name: string;
}

export interface AuthoredSkillProvenance {
  eveSessionId: string;
  eveTurnId: string;
}

export interface PublishAuthoredSkillResult {
  /** Advisory rubric findings; empty when the content is clean. */
  warnings?: string[];
  /** Example created from this publish's trial request, when the cap allowed one. */
  exampleAdded?: AuthoredSkillExample | null;
  name: string;
  replayed: boolean;
  version: number;
}

export interface PublishAuthoredSkillOptions {
  knownToolNames: ReadonlySet<string>;
  operationKey: string;
  provenance: AuthoredSkillProvenance;
  /** The request of the trial run; stored as a new example when given. */
  trialRequest?: string;
  /** Reruns of the stored examples; mandatory for every active example from version 2 on. */
  trials?: readonly AuthoredSkillTrial[];
}

interface SkillRow {
  description: string;
  files: Record<string, string>;
  id: string;
  markdown: string;
  name: string;
  status: "active" | "retired";
  updated_at: Date;
  version: number;
}

async function lockFamilyLibrary(client: PoolClient, familyId: string): Promise<void> {
  // Serializes concurrent publishes of one family so the active-name uniqueness and the 40-skill
  // limit are checked against a settled state.
  await client.query("SELECT 1 FROM families WHERE id = $1 FOR UPDATE", [familyId]);
}

async function replayedVersion(
  client: PoolClient,
  familyId: string,
  operationKey: string,
): Promise<PublishAuthoredSkillResult | null> {
  const result = await client.query<{ name: string; version: number }>(
    `SELECT skill.name, version.version
       FROM authored_skill_versions AS version
       JOIN authored_skills AS skill ON skill.id = version.skill_id
      WHERE version.family_id = $1 AND version.operation_key = $2`,
    [familyId, operationKey],
  );
  const row = result.rows[0];
  return row ? { name: row.name, replayed: true, version: row.version } : null;
}

async function activeSkill(client: PoolClient, familyId: string, name: string): Promise<SkillRow | null> {
  const result = await client.query<SkillRow>(
    `SELECT id, name, description, markdown, files, version, status, updated_at
       FROM authored_skills WHERE family_id = $1 AND name = $2 AND status = 'active' FOR UPDATE`,
    [familyId, name],
  );
  return result.rows[0] ?? null;
}

async function insertVersion(client: PoolClient, input: {
  caller: FamilyCaller;
  changeNote: string;
  content: { description: string; files: Readonly<Record<string, string>>; markdown: string };
  operationKey: string;
  provenance: AuthoredSkillProvenance;
  skillId: string;
  trials: readonly AuthoredSkillTrial[];
  trialSummary: string;
  version: number;
}): Promise<void> {
  await client.query(
    `INSERT INTO authored_skill_versions
       (skill_id, family_id, version, description, markdown, files, change_note, trial_summary,
        operation_key, eve_session_id, eve_turn_id, created_by_user_id, trials)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13::jsonb)`,
    [input.skillId, input.caller.familyId, input.version, input.content.description,
      input.content.markdown, JSON.stringify(input.content.files), input.changeNote,
      input.trialSummary, input.operationKey, input.provenance.eveSessionId,
      input.provenance.eveTurnId, input.caller.userId, JSON.stringify(input.trials)],
  );
}

function summary(row: SkillRow & { last_outcome: string | null; usage_count: string }): AuthoredSkillSummary {
  return {
    description: row.description,
    lastOutcome: row.last_outcome as AuthoredSkillOutcome | null,
    name: row.name,
    status: row.status,
    updatedAt: row.updated_at.toISOString(),
    usageCount: Number(row.usage_count),
    version: row.version,
  };
}

const SUMMARY_SELECT = `
  SELECT skill.id, skill.name, skill.description, skill.markdown, skill.files, skill.version,
         skill.status, skill.updated_at,
         (SELECT count(*)::text FROM authored_skill_usage AS usage WHERE usage.skill_id = skill.id)
           AS usage_count,
         (SELECT usage.outcome FROM authored_skill_usage AS usage
           WHERE usage.skill_id = skill.id ORDER BY usage.loaded_at DESC LIMIT 1) AS last_outcome
    FROM authored_skills AS skill`;

export const authoredSkillRepository = {
  async publish(
    caller: FamilyCaller,
    draft: AuthoredSkillDraft,
    input: PublishAuthoredSkillOptions,
  ): Promise<PublishAuthoredSkillResult> {
    const warnings = assertAuthoredSkillDraft(draft, { knownToolNames: input.knownToolNames });
    const trials = input.trials ?? [];
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      await requireCurrentOwner(client, caller);
      await lockFamilyLibrary(client, caller.familyId);
      const replayed = await replayedVersion(client, caller.familyId, input.operationKey);
      if (replayed) {
        await client.query("COMMIT");
        return { ...replayed, warnings };
      }
      const existing = await activeSkill(client, caller.familyId, draft.name);
      let skillId: string;
      let version: number;
      if (existing) {
        version = existing.version + 1;
        skillId = existing.id;
        // The eval gate: a new version is accepted only after every stored example was rerun.
        requireTrials(await activeExamples(client, skillId), trials);
        await client.query(
          `UPDATE authored_skills
              SET description = $2, markdown = $3, files = $4::jsonb, version = $5, updated_at = now()
            WHERE id = $1`,
          [skillId, draft.description, draft.markdown, JSON.stringify(draft.files), version],
        );
      } else {
        const active = await client.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM authored_skills WHERE family_id = $1 AND status = 'active'",
          [caller.familyId],
        );
        if (Number(active.rows[0]!.count) >= AUTHORED_SKILL_LIMITS.activeSkillsPerFamily) {
          throw new AppError(
            "AGENT_SKILL_LIMIT_REACHED",
            `У семьи уже ${AUTHORED_SKILL_LIMITS.activeSkillsPerFamily} навыков; сначала выведи из употребления ненужный`,
          );
        }
        version = 1;
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO authored_skills
             (family_id, name, description, markdown, files, version, status, created_by_user_id)
           VALUES ($1, $2, $3, $4, $5::jsonb, 1, 'active', $6) RETURNING id`,
          [caller.familyId, draft.name, draft.description, draft.markdown,
            JSON.stringify(draft.files), caller.userId],
        );
        skillId = inserted.rows[0]!.id;
      }
      await insertVersion(client, {
        caller, changeNote: draft.changeNote, content: draft, operationKey: input.operationKey,
        provenance: input.provenance, skillId, trials, trialSummary: draft.trialSummary, version,
      });
      // The trial run of this publish becomes a stored example, so the next version reruns it.
      const exampleAdded = typeof input.trialRequest === "string" && input.trialRequest.trim().length > 0
        ? await insertExample(client, {
          createdByUserId: caller.userId, expected: draft.trialSummary, familyId: caller.familyId,
          request: input.trialRequest, skillId,
        })
        : null;
      await client.query("COMMIT");
      console.info(JSON.stringify({
        code: "AGENT_SKILL_PUBLISHED", familyId: caller.familyId, name: draft.name, version,
        markdownChars: draft.markdown.length, fileCount: Object.keys(draft.files).length,
        trials: trials.length, exampleAdded: exampleAdded !== null,
      }));
      return { exampleAdded, name: draft.name, replayed: false, version, warnings };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async rollback(
    caller: FamilyCaller,
    input: {
      knownToolNames: ReadonlySet<string>;
      name: string;
      operationKey: string;
      provenance: AuthoredSkillProvenance;
      version: number;
    },
  ): Promise<PublishAuthoredSkillResult> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      await requireCurrentOwner(client, caller);
      await lockFamilyLibrary(client, caller.familyId);
      const replayed = await replayedVersion(client, caller.familyId, input.operationKey);
      if (replayed) {
        await client.query("COMMIT");
        return replayed;
      }
      const skill = await activeSkill(client, caller.familyId, input.name);
      if (!skill) throw new AppError("AGENT_SKILL_NOT_FOUND", `Навыка ${input.name} нет среди активных`);
      const target = await client.query<{ description: string; files: Record<string, string>; markdown: string }>(
        `SELECT description, markdown, files FROM authored_skill_versions
          WHERE skill_id = $1 AND version = $2`,
        [skill.id, input.version],
      );
      const content = target.rows[0];
      if (!content) {
        throw new AppError("AGENT_SKILL_VERSION_NOT_FOUND", `У навыка ${input.name} нет версии ${input.version}`);
      }
      // The old version passed the rubric of its day; the tool catalog may have changed since.
      const warnings = assertStoredSkillContent({ ...content, name: input.name }, input.knownToolNames);
      const version = skill.version + 1;
      await client.query(
        `UPDATE authored_skills
            SET description = $2, markdown = $3, files = $4::jsonb, version = $5, updated_at = now()
          WHERE id = $1`,
        [skill.id, content.description, content.markdown, JSON.stringify(content.files), version],
      );
      // A rollback restores content that already passed its examples; no rerun is demanded.
      await insertVersion(client, {
        caller, changeNote: `Откат к версии ${input.version}`, content,
        operationKey: input.operationKey, provenance: input.provenance, skillId: skill.id,
        trials: [], trialSummary: `Возврат содержимого версии ${input.version} без изменений`, version,
      });
      await client.query("COMMIT");
      console.info(JSON.stringify({
        code: "AGENT_SKILL_ROLLED_BACK", familyId: caller.familyId, name: input.name,
        toVersion: input.version, version,
      }));
      return { name: input.name, replayed: false, version, warnings };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async retire(caller: FamilyCaller, input: { name: string }): Promise<{ name: string; version: number }> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      await requireCurrentOwner(client, caller);
      await lockFamilyLibrary(client, caller.familyId);
      const skill = await activeSkill(client, caller.familyId, input.name);
      if (!skill) throw new AppError("AGENT_SKILL_NOT_FOUND", `Навыка ${input.name} нет среди активных`);
      await client.query(
        "UPDATE authored_skills SET status = 'retired', retired_at = now(), updated_at = now() WHERE id = $1",
        [skill.id],
      );
      await client.query("COMMIT");
      console.info(JSON.stringify({
        code: "AGENT_SKILL_RETIRED", familyId: caller.familyId, name: input.name, version: skill.version,
      }));
      return { name: input.name, version: skill.version };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async list(familyId: string): Promise<AuthoredSkillSummary[]> {
    const result = await database().query<SkillRow & { last_outcome: string | null; usage_count: string }>(
      `${SUMMARY_SELECT} WHERE skill.family_id = $1 AND skill.status = 'active' ORDER BY skill.name`,
      [familyId],
    );
    return result.rows.map(summary);
  },

  async read(familyId: string, name: string, version?: number): Promise<AuthoredSkillContent> {
    const result = await database().query<SkillRow & { last_outcome: string | null; usage_count: string }>(
      `${SUMMARY_SELECT} WHERE skill.family_id = $1 AND skill.name = $2 AND skill.status = 'active'`,
      [familyId, name],
    );
    const skill = result.rows[0];
    if (!skill) throw new AppError("AGENT_SKILL_NOT_FOUND", `Навыка ${name} нет среди активных`);
    const wanted = version ?? skill.version;
    const stored = await database().query<{
      change_note: string; description: string; files: Record<string, string>; markdown: string;
      trial_summary: string; trials: AuthoredSkillTrial[];
    }>(
      `SELECT description, markdown, files, change_note, trial_summary, trials
         FROM authored_skill_versions WHERE skill_id = $1 AND version = $2`,
      [skill.id, wanted],
    );
    const content = stored.rows[0];
    if (!content) throw new AppError("AGENT_SKILL_VERSION_NOT_FOUND", `У навыка ${name} нет версии ${wanted}`);
    const examples = await database().query<{ created_at: Date; expected: string; id: string; request: string }>(
      `SELECT id, request, expected, created_at FROM authored_skill_examples
        WHERE skill_id = $1 AND active ORDER BY created_at`,
      [skill.id],
    );
    return {
      ...summary(skill),
      changeNote: content.change_note,
      description: content.description,
      examples: examples.rows.map((row) => ({
        createdAt: row.created_at.toISOString(), expected: row.expected, id: row.id, request: row.request,
      })),
      files: content.files,
      markdown: content.markdown,
      trials: content.trials,
      trialSummary: content.trial_summary,
      version: wanted,
    };
  },

  /** Current content of every active skill: what the dynamic resolver hands to Eve each turn. */
  async activePackages(familyId: string): Promise<AuthoredSkillPackage[]> {
    const result = await database().query<Pick<SkillRow, "description" | "files" | "markdown" | "name">>(
      `SELECT name, description, markdown, files FROM authored_skills
        WHERE family_id = $1 AND status = 'active' ORDER BY name`,
      [familyId],
    );
    return result.rows.map((row) => ({
      description: row.description, files: row.files, markdown: row.markdown, name: row.name,
    }));
  },

  /** Application conversation of the owner's current chat: the family group or the private chat. */
  async conversationId(owner: { chatKind: "family" | "private"; familyId: string; userId: string }): Promise<string | null> {
    const result = owner.chatKind === "family"
      ? await database().query<{ id: string }>(
        `SELECT conversation.id FROM application_conversations AS conversation
           JOIN telegram_groups AS telegram_group ON telegram_group.id = conversation.telegram_group_id
          WHERE conversation.family_id = $1 AND telegram_group.type = 'family_private'
          ORDER BY conversation.created_at LIMIT 1`,
        [owner.familyId],
      )
      : await database().query<{ id: string }>(
        `SELECT id FROM application_conversations
          WHERE family_id = $1 AND owner_user_id = $2 AND scope = 'personal' LIMIT 1`,
        [owner.familyId, owner.userId],
      );
    return result.rows[0]?.id ?? null;
  },

  /** Records one observed `load_skill` of an active authored skill; unknown names are ignored. */
  async recordUsage(input: {
    conversationId: string | null;
    eveSessionId: string;
    eveTurnId: string;
    familyId: string;
    skillName: string;
  }): Promise<boolean> {
    const result = await database().query(
      `INSERT INTO authored_skill_usage (skill_id, family_id, conversation_id, eve_session_id, eve_turn_id)
       SELECT id, family_id, $3, $4, $5 FROM authored_skills
        WHERE family_id = $1 AND name = $2 AND status = 'active'`,
      [input.familyId, input.skillName, input.conversationId, input.eveSessionId, input.eveTurnId],
    );
    if ((result.rowCount ?? 0) > 0) {
      console.info(JSON.stringify({
        code: "AGENT_SKILL_LOADED", familyId: input.familyId, name: input.skillName,
        eveSessionId: input.eveSessionId, eveTurnId: input.eveTurnId,
      }));
    }
    return (result.rowCount ?? 0) > 0;
  },

  /** Whether the family has an active authored skill with this name (static skills are not ours). */
  async isAuthoredSkill(familyId: string, name: string): Promise<boolean> {
    const result = await database().query(
      "SELECT 1 FROM authored_skills WHERE family_id = $1 AND name = $2 AND status = 'active'",
      [familyId, name],
    );
    return (result.rowCount ?? 0) > 0;
  },

  /**
   * Sets the outcome of the latest usage of the skill in this conversation. Without a known
   * conversation there is no usage to address: the latest one in the family may belong to another
   * chat (upstream 960c4b9). An automatic outcome only fills an unknown one and never replaces
   * what the owner said about the same usage.
   */
  async recordOutcome(caller: Pick<FamilyCaller, "familyId">, input: {
    conversationId: string | null;
    name: string;
    note: string | null;
    outcome: Exclude<AuthoredSkillOutcome, "unknown">;
    source: "automatic" | "owner";
  }): Promise<{ name: string; outcome: AuthoredSkillOutcome; usageFound: boolean }> {
    if (input.conversationId === null) {
      throw new AppError(
        "AGENT_SKILL_OUTCOME_CONVERSATION_REQUIRED",
        "Не удалось определить разговор, в котором применялся навык; исход не записан",
      );
    }
    const result = await database().query(
      `UPDATE authored_skill_usage SET outcome = $3, note = $4, outcome_at = now()
        WHERE id = (
          SELECT usage.id FROM authored_skill_usage AS usage
            JOIN authored_skills AS skill ON skill.id = usage.skill_id
           WHERE skill.family_id = $1 AND skill.name = $2 AND usage.conversation_id = $5::uuid
           ORDER BY usage.loaded_at DESC LIMIT 1)
          AND ($6::text = 'owner' OR outcome = 'unknown')`,
      [caller.familyId, input.name, input.outcome, input.note, input.conversationId, input.source],
    );
    const usageFound = (result.rowCount ?? 0) > 0;
    console.info(JSON.stringify({
      code: "AGENT_SKILL_OUTCOME", familyId: caller.familyId, name: input.name,
      outcome: input.outcome, usageFound,
    }));
    return { name: input.name, outcome: input.outcome, usageFound };
  },
};
