/**
 * Eve event handling behind the improvement backlog.
 *
 * Export:
 * - `createImprovementSignalHandlers`: collects turn evidence, decides on the trigger, closes the
 *   loop for loaded authored skills, runs the reflection and records the items for the family.
 *
 * Key constructs:
 * - Silent memory review, scheduled runs and subagents never reflect; an external group does,
 *   because most tool failures happen there, but its evidence carries no message text either.
 * - An authored skill loaded in a failed or heavy turn gets a `failed` outcome and a `skill` item
 *   from the application alone: no model call, and outside the reflection budget. The outcome
 *   needs the turn's conversation and never overwrites an outcome the owner gave.
 * - A `workflow` item recurring the second time in a trusted chat leaves a backlog hint for the
 *   next turn, so the model can offer a skill once. Later recurrences stay silent.
 */
import type { SessionAuth } from "eve/context";

import { isMemoryReviewSession } from "../memory-review/memory-review-session.js";
import { isScheduledSession } from "../agent-schedules/scheduled-session.js";
import type { ImprovementItemInput } from "./improvement-backlog-repository.js";
import { createReflectionRateLimiter, type ReflectionGenerate, reflectOnTurn } from "./reflection.js";
import {
  createTurnEvidenceCollector,
  improvementFingerprint,
  shouldReflectOnTurn,
  type TurnEvidence,
} from "./turn-evidence.js";

type ChatKind = "external" | "family" | "private";

/** Recurrence at which a workflow problem is worth one skill offer. */
export const BACKLOG_HINT_RECURRENCE = 2;

interface SignalContext {
  channel: { kind?: string };
  session: { auth: SessionAuth; id: string };
}

export interface ImprovementIdentity {
  chatKind: ChatKind;
  familyId: string;
  /** Registered Telegram group of a group chat; null in a private chat. */
  groupId: string | null;
  userId: string | null;
}

interface ImprovementSignalDependencies {
  /** Application conversation of the chat, when the identity maps to one. */
  conversationId(identity: ImprovementIdentity): Promise<string | null>;
  generate?: ReflectionGenerate;
  isAuthoredSkill(familyId: string, name: string): Promise<boolean>;
  record(input: ImprovementItemInput): Promise<{ item: { recurrenceCount: number }; recurred: boolean }>;
  /** Automatic: fills only an unknown outcome and never replaces the owner's. */
  recordSkillOutcome(input: {
    conversationId: string;
    familyId: string;
    name: string;
    note: string;
  }): Promise<{ usageFound: boolean }>;
  saveHint(input: {
    conversationId: string;
    eveSessionId: string;
    eveTurnId: string;
    familyId: string;
    kind: "backlog";
    summary: string;
  }): Promise<void>;
}

function reflectionIdentity(ctx: SignalContext): ImprovementIdentity | null {
  if (ctx.channel.kind === "subagent" || isMemoryReviewSession(ctx) || isScheduledSession(ctx)) return null;
  const attributes = ctx.session.auth.current?.attributes;
  if (ctx.session.auth.current?.authenticator !== "telegram" || !attributes) return null;
  const familyId = attributes.familyId;
  if (typeof familyId !== "string") return null;
  const chatKind = attributes.telegramChatType === "private"
    ? "private"
    : attributes.groupType === "family_private" ? "family" : "external";
  const principalId = ctx.session.auth.current?.principalId;
  const userId = ctx.session.auth.current?.principalType === "user" && typeof principalId === "string"
    ? principalId
    : null;
  const groupId = typeof attributes.groupId === "string" ? attributes.groupId : null;
  return { chatKind, familyId, groupId, userId };
}

/** What went wrong in the turn, in tool and code terms; the heavy-turn case names the step count. */
function failureNote(evidence: TurnEvidence): string {
  const codes = [
    ...evidence.failedTools.map((failure) => `${failure.toolName}: ${failure.code}`),
    ...(evidence.turnFailure ? [`ход: ${evidence.turnFailure.code}`] : []),
  ];
  return codes.length > 0 ? codes.join("; ") : `${evidence.stepCount} шагов инструментов`;
}

function skillItemSummary(name: string, evidence: TurnEvidence): string {
  const failure = evidence.failedTools[0];
  if (failure) return `Навык ${name} не справился: ${failure.toolName} упал с ${failure.code}`;
  if (evidence.turnFailure) return `Навык ${name} не справился: ход упал с ${evidence.turnFailure.code}`;
  return `Навык ${name}: ход занял ${evidence.stepCount} шагов инструментов`;
}

export function createImprovementSignalHandlers(dependencies: ImprovementSignalDependencies) {
  const collector = createTurnEvidenceCollector();
  const limiter = createReflectionRateLimiter();

  function turnEvidence(ctx: SignalContext, turnId: string, evidence: TurnEvidence): Record<string, unknown> {
    return {
      eveSessionId: ctx.session.id,
      eveTurnId: turnId,
      failedTools: evidence.failedTools,
      loadedSkills: evidence.loadedSkills,
      stepCount: evidence.stepCount,
      toolNames: evidence.toolNames,
      turnFailure: evidence.turnFailure,
    };
  }

  async function closeSkillLoop(
    ctx: SignalContext, turnId: string, identity: ImprovementIdentity, evidence: TurnEvidence,
    conversationId: string | null,
  ): Promise<void> {
    for (const name of new Set(evidence.loadedSkills)) {
      if (!await dependencies.isAuthoredSkill(identity.familyId, name)) continue;
      const note = failureNote(evidence);
      // Without the turn's conversation no usage can be addressed; the backlog item still records it.
      const outcome = conversationId === null
        ? { usageFound: false }
        : await dependencies.recordSkillOutcome({ conversationId, familyId: identity.familyId, name, note });
      const failure = evidence.failedTools[0];
      const errorCode = failure?.code ?? evidence.turnFailure?.code ?? "HEAVY_TURN";
      const summary = skillItemSummary(name, evidence);
      const result = await dependencies.record({
        category: "skill",
        evidence: { ...turnEvidence(ctx, turnId, evidence), errorCode, skillName: name, toolName: failure?.toolName ?? null },
        familyId: identity.familyId,
        fingerprint: improvementFingerprint({ category: "skill", errorCode, summary, toolName: name }),
        priority: "medium",
        summary,
      });
      console.info(JSON.stringify({
        code: "AGENT_IMPROVEMENT_SKILL_OUTCOME",
        name,
        recurrenceCount: result.item.recurrenceCount,
        usageFound: outcome.usageFound,
      }));
    }
  }

  async function finish(ctx: SignalContext, turnId: string, evidence: TurnEvidence | null): Promise<void> {
    if (!evidence || !shouldReflectOnTurn(evidence)) return;
    const identity = reflectionIdentity(ctx);
    if (!identity) return;
    const conversationId = await dependencies.conversationId(identity);
    await closeSkillLoop(ctx, turnId, identity, evidence, conversationId);
    if (!limiter.admit(identity.familyId)) {
      console.info(JSON.stringify({ code: "AGENT_IMPROVEMENT_SKIPPED", reason: "rate_limit", familyId: identity.familyId }));
      return;
    }
    const items = await reflectOnTurn({ chatKind: identity.chatKind, evidence }, dependencies.generate);
    console.info(JSON.stringify({
      code: "AGENT_IMPROVEMENT_REFLECTED",
      chatKind: identity.chatKind,
      failedTools: evidence.failedTools.length,
      items: items.length,
      stepCount: evidence.stepCount,
      turnFailed: evidence.turnFailure !== null,
    }));
    for (const item of items) {
      const result = await dependencies.record({
        category: item.category,
        evidence: { ...turnEvidence(ctx, turnId, evidence), errorCode: item.errorCode, toolName: item.toolName },
        familyId: identity.familyId,
        fingerprint: item.fingerprint,
        priority: item.priority,
        summary: item.summary,
      });
      console.info(JSON.stringify({
        code: "AGENT_IMPROVEMENT_RECORDED",
        category: item.category,
        fingerprint: item.fingerprint,
        recurred: result.recurred,
      }));
      const hintWorthy = item.category === "workflow" &&
        result.item.recurrenceCount === BACKLOG_HINT_RECURRENCE &&
        identity.chatKind !== "external" &&
        conversationId !== null;
      if (!hintWorthy) continue;
      await dependencies.saveHint({
        conversationId, eveSessionId: ctx.session.id, eveTurnId: turnId, familyId: identity.familyId,
        kind: "backlog", summary: item.summary,
      });
      console.info(JSON.stringify({ code: "AGENT_IMPROVEMENT_HINT_SAVED", fingerprint: item.fingerprint }));
    }
  }

  return {
    actionsRequested(event: { data: { actions: readonly { callId?: string; input?: unknown; kind: string; toolName?: string }[]; turnId: string } }, ctx: SignalContext): void {
      collector.actionsRequested({ actions: event.data.actions, sessionId: ctx.session.id, turnId: event.data.turnId });
    },
    actionResult(event: { data: { error?: { code: string; message: string }; result: { callId?: string; kind: string; toolName?: string }; status: "completed" | "failed" | "rejected"; turnId: string } }, ctx: SignalContext): void {
      collector.actionResult({
        callId: event.data.result.callId,
        error: event.data.error,
        sessionId: ctx.session.id,
        status: event.data.status,
        toolName: event.data.result.kind === "tool-result" ? event.data.result.toolName : undefined,
        turnId: event.data.turnId,
      });
    },
    async turnCompleted(event: { data: { turnId: string } }, ctx: SignalContext): Promise<void> {
      await finish(ctx, event.data.turnId, collector.take(ctx.session.id, event.data.turnId));
    },
    async turnFailed(event: { data: { code: string; message: string; turnId: string } }, ctx: SignalContext): Promise<void> {
      collector.turnFailed({ code: event.data.code, message: event.data.message, sessionId: ctx.session.id, turnId: event.data.turnId });
      await finish(ctx, event.data.turnId, collector.take(ctx.session.id, event.data.turnId));
    },
  };
}
