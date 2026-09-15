/**
 * Skill library signals.
 *
 * Export:
 * - Eve hook recording authored-skill loads and the repeat-task hint from tool-call counts.
 *
 * Key construct:
 * - Failures are logged, never thrown: a bookkeeping hook must not fail a Telegram turn.
 */
import { defineHook } from "eve/hooks";

import { authoredSkillGrantRepository } from "../lib/authored-skills/authored-skill-grant-repository.js";
import { authoredSkillRepository } from "../lib/authored-skills/authored-skill-repository.js";
import { skillHintRepository } from "../lib/authored-skills/skill-hint-repository.js";
import { createSkillSignalHandlers } from "../lib/authored-skills/skill-signals.js";

const handlers = createSkillSignalHandlers({
  conversationId: (owner) => authoredSkillRepository.conversationId(owner),
  groupConversationId: (groupId) => authoredSkillGrantRepository.groupConversationId(groupId),
  recordUsage: (input) => authoredSkillRepository.recordUsage(input),
  saveHint: (input) => skillHintRepository.save(input),
});

function report(stage: string, error: unknown): void {
  console.error(JSON.stringify({
    code: "AGENT_SKILL_SIGNAL_FAILED",
    error: error instanceof Error ? error.message : String(error),
    stage,
  }));
}

export default defineHook({
  events: {
    async "actions.requested"(event, ctx) {
      try {
        await handlers.actionsRequested(event, ctx);
      } catch (error) {
        report("actions.requested", error);
      }
    },
    async "turn.completed"(event, ctx) {
      try {
        await handlers.turnCompleted(event, ctx);
      } catch (error) {
        report("turn.completed", error);
      }
    },
  },
});
