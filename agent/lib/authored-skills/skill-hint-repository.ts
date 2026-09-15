/**
 * Skill hints: one row per conversation, consumed by the next turn's context.
 *
 * Exports:
 * - `SKILL_HINT_MIN_STEPS`, `SKILL_HINT_IGNORED_TOOLS`, `SKILL_HINT_TTL_MILLISECONDS`.
 * - `SkillHint`: `repeat` (a heavy turn just happened) or `backlog` (a workflow problem recurred).
 * - `skillHintRepository.save` / `take`: upsert after the signal, read-and-delete before the next turn.
 * - `formatSkillHint`: the single context line the model sees.
 *
 * Key construct:
 * - The application decides when a task looked repeatable (tool-call count, backlog recurrence);
 *   the model only phrases the offer. Without a row the model has no reason to bring skills up.
 */
import { database } from "../database.js";

export const SKILL_HINT_MIN_STEPS = 4;
export const SKILL_HINT_TTL_MILLISECONDS = 24 * 60 * 60 * 1_000;
/** Bookkeeping calls that every turn makes; they say nothing about the task being repeatable. */
export const SKILL_HINT_IGNORED_TOOLS: ReadonlySet<string> = new Set([
  "get_current_time", "list_memories", "load_skill", "manage_skill", "read_profile_view",
  "remember", "search_memories", "search_memory_threads", "list_memory_threads", "read_memory_thread",
]);

export type SkillHint =
  | { kind: "backlog"; summary: string }
  | { kind: "repeat"; stepCount: number; toolNames: readonly string[] };

export function formatSkillHint(hint: SkillHint): string {
  if (hint.kind === "backlog") {
    return [
      `В бэклоге улучшений второй раз повторяется: ${hint.summary}`,
      "Если это повторяемая задача, предложи оформить её как навык одной фразой; без ответа не настаивай.",
    ].join(" ");
  }
  return [
    `Предыдущая задача в этом чате потребовала ${hint.stepCount} шагов инструментов: ${hint.toolNames.join(", ")}.`,
    "Если такая задача будет повторяться, предложи сохранить её как навык одной фразой; без ответа не настаивай.",
  ].join(" ");
}

interface HintRow {
  created_at: Date;
  kind: "backlog" | "repeat";
  step_count: number | null;
  summary: string | null;
  tool_names: string[];
}

function rowToHint(row: HintRow): SkillHint | null {
  if (row.kind === "backlog") return row.summary === null ? null : { kind: "backlog", summary: row.summary };
  return row.step_count === null ? null : { kind: "repeat", stepCount: row.step_count, toolNames: row.tool_names };
}

export const skillHintRepository = {
  /** Upserts the conversation's pending hint; a later signal replaces an earlier one. */
  async save(input: SkillHint & {
    conversationId: string;
    eveSessionId: string;
    eveTurnId: string;
    familyId: string;
  }): Promise<void> {
    const stepCount = input.kind === "repeat" ? input.stepCount : null;
    const toolNames = input.kind === "repeat" ? [...input.toolNames] : [];
    const summary = input.kind === "backlog" ? input.summary : null;
    await database().query(
      `INSERT INTO conversation_skill_hints
         (conversation_id, family_id, kind, step_count, tool_names, summary, eve_session_id, eve_turn_id, created_at)
       VALUES ($1, $2, $3, $4, $5::text[], $6, $7, $8, now())
       ON CONFLICT (conversation_id) DO UPDATE
         SET kind = EXCLUDED.kind, step_count = EXCLUDED.step_count, tool_names = EXCLUDED.tool_names,
             summary = EXCLUDED.summary,
             eve_session_id = EXCLUDED.eve_session_id, eve_turn_id = EXCLUDED.eve_turn_id,
             created_at = now()`,
      [input.conversationId, input.familyId, input.kind, stepCount, toolNames, summary,
        input.eveSessionId, input.eveTurnId],
    );
  },

  /** Returns and removes the pending hint; a stale one is removed without being shown. */
  async take(conversationId: string, now: Date = new Date()): Promise<SkillHint | null> {
    const result = await database().query<HintRow>(
      `DELETE FROM conversation_skill_hints WHERE conversation_id = $1
       RETURNING kind, step_count, tool_names, summary, created_at`,
      [conversationId],
    );
    const row = result.rows[0];
    if (!row) return null;
    if (now.getTime() - row.created_at.getTime() > SKILL_HINT_TTL_MILLISECONDS) return null;
    return rowToHint(row);
  },
};
