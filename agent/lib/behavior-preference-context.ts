/**
 * Verified current-chat authorization for communication preferences.
 *
 * Exports:
 * - `BehaviorPreferenceAuthorization`: exact conversation, actor, source, and sequence.
 * - `BehaviorPreferenceBotReadAuthorization`: read-only source for a turn started by another bot.
 * - `BehaviorPreferenceReadAuthorization`: interactive, bot, or server-authored scheduled target.
 * - `requireBehaviorPreferenceAuthorization`: projects trusted Telegram auth or fails closed.
 * - `requireBehaviorPreferenceReadAuthorization`: also admits read-only scheduled delivery auth.
 */
import type { SessionContext } from "eve/context";
import type { DynamicResolveContext } from "eve/instructions";

import { scheduledDeliveryMetadata } from "./agent-schedules/scheduled-session.js";
import { AppError } from "./app-error.js";
import { resolveSessionCaller } from "./session-auth.js";
import { resolveTelegramSessionActor } from "./telegram-session-actor.js";

export interface BehaviorPreferenceAuthorization {
  conversationId: string;
  sourceSequence: string;
  telegramUserId: string;
  timelineEntryId: string;
}

export interface BehaviorPreferenceScheduledReadAuthorization {
  actorUserId: string;
  familyId: string;
  groupId: string | null;
  kind: "scheduled";
  scope: "family" | "group" | "personal";
  telegramChatId: string;
}

export interface BehaviorPreferenceBotReadAuthorization {
  conversationId: string;
  kind: "bot";
  sourceSequence: string;
  telegramBotId: string;
  timelineEntryId: string;
}

export type BehaviorPreferenceReadAuthorization =
  | BehaviorPreferenceAuthorization
  | BehaviorPreferenceBotReadAuthorization
  | BehaviorPreferenceScheduledReadAuthorization;

type PreferenceContext =
  | Pick<DynamicResolveContext, "session">
  | Pick<SessionContext, "session">;

function contextError(): AppError {
  return new AppError(
    "AGENT_BEHAVIOR_PREFERENCE_CONTEXT_INVALID",
    "Не удалось определить текущий Telegram-чат для настройки общения. Отправьте просьбу ещё раз",
  );
}

export function requireBehaviorPreferenceAuthorization(
  ctx: PreferenceContext,
): BehaviorPreferenceAuthorization {
  const caller = resolveSessionCaller(ctx);
  const attributes = caller?.attributes;
  const conversationId = attributes?.telegramConversationId;
  const sourceSequence = attributes?.telegramTimelineSequence;
  const telegramUserId = attributes?.telegramUserId;
  const timelineEntryId = attributes?.telegramTimelineEntryId;

  // All mutation ordering and scope come from the current verified Telegram source, never the model.
  if (
    caller?.principalType !== "user" ||
    caller.authenticator !== "telegram" ||
    typeof conversationId !== "string" ||
    typeof sourceSequence !== "string" ||
    !/^\d+$/u.test(sourceSequence) ||
    typeof telegramUserId !== "string" ||
    telegramUserId.length === 0 ||
    typeof timelineEntryId !== "string"
  ) {
    throw contextError();
  }

  return {
    conversationId,
    sourceSequence,
    telegramUserId,
    timelineEntryId,
  };
}

export function requireBehaviorPreferenceReadAuthorization(
  ctx: PreferenceContext,
): BehaviorPreferenceReadAuthorization {
  // Scheduled runs carry a server-authored delivery target but intentionally have no user message.
  const scheduled = scheduledDeliveryMetadata(ctx);
  if (scheduled) {
    const caller = resolveSessionCaller(ctx);
    const callerScheduledRunId = caller?.attributes?.scheduledRunId;

    // Never combine a normal current caller with delivery metadata inherited from another principal.
    if (
      !caller ||
      caller.principalType !== "user" ||
      caller.authenticator !== "telegram" ||
      callerScheduledRunId !== scheduled.runId
    ) {
      throw contextError();
    }
    return {
      actorUserId: caller.principalId,
      familyId: scheduled.familyId,
      groupId: scheduled.groupId,
      kind: "scheduled",
      scope: scheduled.scope,
      telegramChatId: scheduled.telegramChatId,
    };
  }
  // A turn started by another bot reads the chat's instructions but can never rewrite them.
  const bot = botReadAuthorization(ctx);
  if (bot) return bot;
  return requireBehaviorPreferenceAuthorization(ctx);
}

function botReadAuthorization(ctx: PreferenceContext): BehaviorPreferenceBotReadAuthorization | null {
  const caller = resolveSessionCaller(ctx);
  const attributes = caller?.attributes;
  if (attributes?.telegramActorKind !== "telegram_bot") return null;
  const actor = resolveTelegramSessionActor(ctx.session.auth);
  const conversationId = attributes.telegramConversationId;
  const sourceSequence = attributes.telegramTimelineSequence;
  const timelineEntryId = attributes.telegramTimelineEntryId;
  if (
    actor === null ||
    caller?.authenticator !== "telegram" ||
    typeof conversationId !== "string" ||
    typeof sourceSequence !== "string" ||
    !/^\d+$/u.test(sourceSequence) ||
    typeof timelineEntryId !== "string"
  ) {
    throw contextError();
  }
  return { conversationId, kind: "bot", sourceSequence, telegramBotId: actor.id, timelineEntryId };
}
