/**
 * Eve event handlers behind the skill library: observed loads and the repeat-task signal.
 *
 * Exports:
 * - `createSkillSignalHandlers`: `actions.requested` records `load_skill` of an authored skill
 *   (trusted chats and external groups holding a grant) and counts tool calls per turn;
 *   `turn.completed` turns a heavy trusted turn into a hint row.
 * - `trustedChatKind`: private-owner / family classification shared with the resolver.
 *
 * Key constructs:
 * - Counting lives in a bounded in-memory map keyed by session and turn; a restart loses at most
 *   the current turn's count, which is acceptable for a hint.
 * - Silent review, scheduled runs and subagents produce neither usage rows nor hints; an external
 *   group records loads of the skills granted to it but never gets a hint: the library is not its.
 */
import type { SessionAuth } from "eve/context";

import { isScheduledSession } from "../agent-schedules/scheduled-session.js";
import { isMemoryReviewSession } from "../memory-review/memory-review-session.js";
import { SKILL_HINT_IGNORED_TOOLS, SKILL_HINT_MIN_STEPS } from "./skill-hint-repository.js";

export type TrustedChatKind = "family" | "private";

interface SkillSignalContext {
  channel: { kind?: string };
  session: { auth: SessionAuth; id: string };
}

interface SkillSignalAction {
  readonly [key: string]: unknown;
  input?: unknown;
  kind: string;
  toolName?: string;
}

interface SkillSignalDependencies {
  conversationId(owner: { chatKind: TrustedChatKind; familyId: string; userId: string }): Promise<string | null>;
  /** Conversation of a registered external group, for loads of skills granted to it. */
  groupConversationId(groupId: string): Promise<string | null>;
  recordUsage(input: {
    conversationId: string | null;
    eveSessionId: string;
    eveTurnId: string;
    familyId: string;
    skillName: string;
  }): Promise<boolean>;
  saveHint(input: {
    conversationId: string;
    eveSessionId: string;
    eveTurnId: string;
    familyId: string;
    kind: "repeat";
    stepCount: number;
    toolNames: readonly string[];
  }): Promise<void>;
}

const MAX_TRACKED_TURNS = 200;

/** Owner's private chat or the family group; null for everything else. */
export function trustedChatKind(auth: SessionAuth): TrustedChatKind | null {
  const attributes = auth.current?.attributes;
  if (auth.current?.authenticator !== "telegram" || !attributes) return null;
  if (attributes.telegramChatType === "private") return attributes.role === "owner" ? "private" : null;
  return attributes.groupType === "family_private" ? "family" : null;
}

function trustedIdentity(ctx: SkillSignalContext): {
  chatKind: TrustedChatKind; familyId: string; userId: string;
} | null {
  if (ctx.channel.kind === "subagent" || isMemoryReviewSession(ctx) || isScheduledSession(ctx)) return null;
  const chatKind = trustedChatKind(ctx.session.auth);
  const attributes = ctx.session.auth.current?.attributes;
  const familyId = attributes?.familyId;
  const userId = ctx.session.auth.current?.principalId;
  if (chatKind === null || typeof familyId !== "string" || typeof userId !== "string") return null;
  return { chatKind, familyId, userId };
}

/** A live external group turn: its granted skills are loaded here, so usage is recorded here too. */
function externalIdentity(ctx: SkillSignalContext): { familyId: string; groupId: string } | null {
  if (ctx.channel.kind === "subagent" || isMemoryReviewSession(ctx) || isScheduledSession(ctx)) return null;
  const attributes = ctx.session.auth.current?.attributes;
  if (ctx.session.auth.current?.authenticator !== "telegram" || attributes?.groupType !== "external") return null;
  const familyId = attributes.familyId;
  const groupId = attributes.groupId;
  return typeof familyId === "string" && typeof groupId === "string" ? { familyId, groupId } : null;
}

export function createSkillSignalHandlers(dependencies: SkillSignalDependencies) {
  const toolCalls = new Map<string, string[]>();

  function remember(key: string, toolName: string): void {
    const names = toolCalls.get(key) ?? [];
    names.push(toolName);
    toolCalls.delete(key);
    toolCalls.set(key, names);
    // Oldest turns fall out first; a turn that never completes does not leak forever.
    while (toolCalls.size > MAX_TRACKED_TURNS) {
      const oldest = toolCalls.keys().next().value;
      if (oldest === undefined) break;
      toolCalls.delete(oldest);
    }
  }

  return {
    async actionsRequested(event: { data: { actions: readonly SkillSignalAction[]; turnId: string } }, ctx: SkillSignalContext): Promise<void> {
      const identity = trustedIdentity(ctx);
      const external = identity ? null : externalIdentity(ctx);
      if (!identity && !external) return;
      const key = `${ctx.session.id}:${event.data.turnId}`;
      for (const action of event.data.actions) {
        if (action.kind === "load-skill") {
          const skill = (action.input as { skill?: unknown } | undefined)?.skill;
          if (typeof skill !== "string") continue;
          const familyId = identity?.familyId ?? external!.familyId;
          const conversationId = identity
            ? await dependencies.conversationId(identity)
            : await dependencies.groupConversationId(external!.groupId);
          await dependencies.recordUsage({
            conversationId, eveSessionId: ctx.session.id, eveTurnId: event.data.turnId,
            familyId, skillName: skill,
          });
          continue;
        }
        // The repeat-task hint stays a trusted-chat affair: an external group cannot author skills.
        if (!identity) continue;
        if (action.kind !== "tool-call" || typeof action.toolName !== "string") continue;
        if (SKILL_HINT_IGNORED_TOOLS.has(action.toolName)) continue;
        remember(key, action.toolName);
      }
    },

    async turnCompleted(event: { data: { turnId: string } }, ctx: SkillSignalContext): Promise<void> {
      const key = `${ctx.session.id}:${event.data.turnId}`;
      const names = toolCalls.get(key);
      toolCalls.delete(key);
      if (!names || names.length < SKILL_HINT_MIN_STEPS) return;
      const identity = trustedIdentity(ctx);
      if (!identity) return;
      const conversationId = await dependencies.conversationId(identity);
      if (conversationId === null) return;
      await dependencies.saveHint({
        conversationId, eveSessionId: ctx.session.id, eveTurnId: event.data.turnId,
        familyId: identity.familyId, kind: "repeat", stepCount: names.length, toolNames: [...new Set(names)],
      });
    },
  };
}
