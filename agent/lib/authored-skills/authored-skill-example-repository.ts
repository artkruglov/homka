/**
 * Stored examples of an authored skill: the fixed set every new version must be rerun against.
 *
 * Exports:
 * - `AuthoredSkillExample`, `AuthoredSkillTrial`: an example and one rerun of it.
 * - `authoredSkillExampleRepository`: `add` / `remove` (owner, trusted chat), `list`.
 * - `activeExamples`, `insertExample`, `requireTrials`: transaction helpers used by publish.
 *
 * Key constructs:
 * - Up to five active examples per skill; removal is a flag, so an old version's trials still
 *   point at the example they ran.
 * - `requireTrials` is the eval gate: version 2 and later must carry a trial for every active
 *   example, else `AGENT_SKILL_EVAL_MISSING` names the ones not rerun and the call is retryable.
 */
import type { PoolClient } from "pg";

import { AppError } from "../app-error.js";
import { database } from "../database.js";
import type { FamilyCaller } from "../family-context.js";
import { requireCurrentOwner } from "./authored-skill-owner.js";

export const AUTHORED_SKILL_EXAMPLES_MAX = 5;
export const AUTHORED_SKILL_EXAMPLE_MAX_CHARACTERS = 1_000;

export interface AuthoredSkillExample {
  createdAt: string;
  expected: string;
  id: string;
  request: string;
}

export interface AuthoredSkillTrial {
  exampleId: string;
  summary: string;
}

interface ExampleRow {
  created_at: Date;
  expected: string;
  id: string;
  request: string;
}

function rowToExample(row: ExampleRow): AuthoredSkillExample {
  return { createdAt: row.created_at.toISOString(), expected: row.expected, id: row.id, request: row.request };
}

export async function activeExamples(client: PoolClient, skillId: string): Promise<AuthoredSkillExample[]> {
  const result = await client.query<ExampleRow>(
    `SELECT id, request, expected, created_at FROM authored_skill_examples
      WHERE skill_id = $1 AND active ORDER BY created_at`,
    [skillId],
  );
  return result.rows.map(rowToExample);
}

/** Adds an example when the cap allows; returns null when the skill already holds five. */
export async function insertExample(client: PoolClient, input: {
  createdByUserId: string;
  expected: string;
  familyId: string;
  request: string;
  skillId: string;
}): Promise<AuthoredSkillExample | null> {
  const existing = await activeExamples(client, input.skillId);
  if (existing.length >= AUTHORED_SKILL_EXAMPLES_MAX) return null;
  const result = await client.query<ExampleRow>(
    `INSERT INTO authored_skill_examples (skill_id, family_id, request, expected, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING id, request, expected, created_at`,
    [input.skillId, input.familyId, input.request.trim(), input.expected.trim(), input.createdByUserId],
  );
  return rowToExample(result.rows[0]!);
}

/** Every active example must have been rerun; unknown example ids in the trials are refused. */
export function requireTrials(
  examples: readonly AuthoredSkillExample[],
  trials: readonly AuthoredSkillTrial[],
): void {
  const known = new Set(examples.map((example) => example.id));
  const unknown = trials.filter((trial) => !known.has(trial.exampleId)).map((trial) => trial.exampleId);
  if (unknown.length > 0) {
    throw new AppError("AGENT_SKILL_EVAL_UNKNOWN_EXAMPLE", `Таких примеров у навыка нет: ${unknown.join(", ")}`);
  }
  const rerun = new Set(trials.map((trial) => trial.exampleId));
  const missing = examples.filter((example) => !rerun.has(example.id));
  if (missing.length === 0) return;
  const listed = missing.map((example) => `${example.id}: ${example.request.slice(0, 80)}`).join("; ");
  throw new AppError(
    "AGENT_SKILL_EVAL_MISSING",
    `Перед новой версией прогони все примеры навыка и передай trials по каждому. Не прогнаны: ${listed}`,
  );
}

async function lockedActiveSkill(client: PoolClient, familyId: string, name: string): Promise<{ id: string }> {
  const result = await client.query<{ id: string }>(
    "SELECT id FROM authored_skills WHERE family_id = $1 AND name = $2 AND status = 'active' FOR UPDATE",
    [familyId, name],
  );
  const row = result.rows[0];
  if (!row) throw new AppError("AGENT_SKILL_NOT_FOUND", `Навыка ${name} нет среди активных`);
  return row;
}

export const authoredSkillExampleRepository = {
  async add(caller: FamilyCaller, input: { expected: string; name: string; request: string }): Promise<AuthoredSkillExample> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      await requireCurrentOwner(client, caller);
      const skill = await lockedActiveSkill(client, caller.familyId, input.name);
      const example = await insertExample(client, {
        createdByUserId: caller.userId, expected: input.expected, familyId: caller.familyId,
        request: input.request, skillId: skill.id,
      });
      if (example === null) {
        throw new AppError(
          "AGENT_SKILL_EXAMPLE_LIMIT_REACHED",
          `У навыка уже ${AUTHORED_SKILL_EXAMPLES_MAX} примеров; сначала убери устаревший через remove_example`,
        );
      }
      await client.query("COMMIT");
      return example;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async remove(caller: FamilyCaller, input: { exampleId: string; name: string }): Promise<{ exampleId: string; name: string }> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      await requireCurrentOwner(client, caller);
      const skill = await lockedActiveSkill(client, caller.familyId, input.name);
      const removed = await client.query(
        `UPDATE authored_skill_examples SET active = false, removed_at = now()
          WHERE id = $1 AND skill_id = $2 AND active`,
        [input.exampleId, skill.id],
      );
      if ((removed.rowCount ?? 0) === 0) {
        throw new AppError("AGENT_SKILL_EXAMPLE_NOT_FOUND", `У навыка ${input.name} нет активного примера ${input.exampleId}`);
      }
      await client.query("COMMIT");
      return { exampleId: input.exampleId, name: input.name };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async list(familyId: string, name: string): Promise<AuthoredSkillExample[]> {
    const result = await database().query<ExampleRow>(
      `SELECT example.id, example.request, example.expected, example.created_at
         FROM authored_skill_examples AS example
         JOIN authored_skills AS skill ON skill.id = example.skill_id
        WHERE skill.family_id = $1 AND skill.name = $2 AND skill.status = 'active' AND example.active
        ORDER BY example.created_at`,
      [familyId, name],
    );
    return result.rows.map(rowToExample);
  },
};
