/**
 * Improvement backlog signals.
 *
 * Export:
 * - Eve hook that turns a failed or heavy turn into reviewed backlog items for the owner, marks
 *   loaded authored skills failed and leaves a skill hint when a workflow problem recurs.
 *
 * Key construct:
 * - Failures are logged, never thrown: a bookkeeping hook must not fail a Telegram turn.
 */
import { defineHook } from "eve/hooks";

import { authoredSkillGrantRepository } from "../lib/authored-skills/authored-skill-grant-repository.js";
import { authoredSkillRepository } from "../lib/authored-skills/authored-skill-repository.js";
import { skillHintRepository } from "../lib/authored-skills/skill-hint-repository.js";
import { improvementBacklogRepository } from "../lib/improvements/improvement-backlog-repository.js";
import { createImprovementSignalHandlers } from "../lib/improvements/improvement-signals.js";

const handlers = createImprovementSignalHandlers({
  // An external group's skills are the ones granted to it, so its outcomes bind to the group's
  // own conversation; trusted chats bind to the owner's conversation.
  conversationId: (identity) => {
    if (identity.chatKind === "external") {
      return identity.groupId === null
        ? Promise.resolve(null)
        : authoredSkillGrantRepository.groupConversationId(identity.groupId);
    }
    return identity.userId === null
      ? Promise.resolve(null)
      : authoredSkillRepository.conversationId({ chatKind: identity.chatKind, familyId: identity.familyId, userId: identity.userId });
  },
  isAuthoredSkill: (familyId, name) => authoredSkillRepository.isAuthoredSkill(familyId, name),
  record: (input) => improvementBacklogRepository.record(input),
  recordSkillOutcome: (input) => authoredSkillRepository.recordOutcome(
    { familyId: input.familyId },
    { conversationId: input.conversationId, name: input.name, note: input.note, outcome: "failed", source: "automatic" },
  ),
  saveHint: (input) => skillHintRepository.save(input),
});

function report(stage: string, error: unknown): void {
  console.error(JSON.stringify({
    code: "AGENT_IMPROVEMENT_SIGNAL_FAILED",
    error: error instanceof Error ? error.message : String(error),
    stage,
  }));
}

export default defineHook({
  events: {
    async "actions.requested"(event, ctx) {
      try {
        handlers.actionsRequested(event, ctx);
      } catch (error) {
        report("actions.requested", error);
      }
    },
    async "action.result"(event, ctx) {
      try {
        handlers.actionResult(event, ctx);
      } catch (error) {
        report("action.result", error);
      }
    },
    async "turn.completed"(event, ctx) {
      try {
        await handlers.turnCompleted(event, ctx);
      } catch (error) {
        report("turn.completed", error);
      }
    },
    async "turn.failed"(event, ctx) {
      try {
        await handlers.turnFailed(event, ctx);
      } catch (error) {
        report("turn.failed", error);
      }
    },
  },
});
