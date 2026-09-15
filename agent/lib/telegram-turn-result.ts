/**
 * Final trusted Telegram inbound result assembly.
 *
 * Exports:
 * - `buildTelegramTurnResult`: composes internal auth attributes and bounded model context.
 */
import type { TelegramInboundResult, TelegramMessage } from "eve/channels/telegram";

import type { StoredTelegramAttachment } from "./attachments/telegram-workspace-attachments.js";
import { formatCurrentTimeContext } from "./current-time.js";
import type { ApplicationConversation } from "./conversation-repository.js";
import type { ConversationAccess, RegisteredGroup } from "./family-access.js";
import type { PreparedTelegramGroupTurnContext } from "./telegram-group-turn-context.js";
import type { TelegramGroupAttachmentSummary } from "./telegram-group-journal-context.js";
import type { PreparedSession } from "./sessions/session-repository.js";
import type { TelegramInboundActor } from "./telegram-inbound-actor.js";
import {
  formatStoredTelegramAttachments,
  formatTelegramAttachmentReferences,
} from "./telegram-on-message-context.js";

export function buildTelegramTurnResult(input: {
  access: ConversationAccess;
  actor: TelegramInboundActor;
  appSession: PreparedSession;
  conversation: ApplicationConversation;
  forumTopicId: string | null;
  group: RegisteredGroup | null;
  lazyAttachment: (TelegramGroupAttachmentSummary & { telegramMessageId: string }) | null;
  memoryContext: readonly string[];
  message: TelegramMessage;
  pendingDelivery: { context: string; cursor: string } | null;
  profileReplyTimelineSequence: string | null;
  profileSignals: {
    explicitMentionTelegramUserIds: readonly string[];
    replyTelegramUserId: string | null;
  };
  replyHandling: "message" | undefined;
  storedAttachments: readonly StoredTelegramAttachment[];
  imageAnalysis: string | null;
  timelineEntryId: string;
  timezone: string | null;
  turnContext: PreparedTelegramGroupTurnContext;
  turnStartedAt: Date;
}): TelegramInboundResult {
  const context = [
    `Verified conversation scope: ${input.access.memoryScopes.join(", ")}.`,
    `Verified role: ${input.access.role}.`,
    `Verified Telegram actor kind: ${input.actor.kind}.`,
    "Verified Telegram delivery: reply in concise plain text by default; use supported Rich Markdown only when formatting materially improves the answer.",
    formatCurrentTimeContext(input.turnStartedAt, input.timezone),
  ];
  if (input.lazyAttachment) context.push(formatTelegramAttachmentReferences([input.lazyAttachment]));
  if (input.pendingDelivery) context.push(input.pendingDelivery.context);
  context.push(...input.memoryContext);

  return {
    auth: {
      attributes: {
        applicationSessionId: input.appSession.id,
        ...(input.appSession.spacePolicy === undefined ? {} : {
          spaceId: input.appSession.spacePolicy.spaceId,
          spacePolicyVersion: String(input.appSession.spacePolicy.policyVersion),
          // Название нужно блоку режима: в личном чате человек обязан видеть активную область.
          spaceTitle: input.appSession.spacePolicy.title,
        }),
        familyId: input.access.familyId,
        ...(input.access.groupId ? { groupId: input.access.groupId } : {}),
        ...(input.group ? { groupType: input.group.type } : {}),
        memoryScopes: input.access.memoryScopes,
        ...(input.pendingDelivery ? { proactiveDeliveryCursor: input.pendingDelivery.cursor } : {}),
        role: input.access.role,
        sandboxSessionId: input.appSession.sandboxSessionId,
        telegramChatId: input.message.chat.id,
        telegramChatType: input.message.chat.type,
        telegramConversationId: input.conversation.id,
        ...(input.forumTopicId === null ? {} : { telegramForumTopicId: input.forumTopicId }),
        telegramMessageId: input.message.messageId,
        ...(input.profileSignals.explicitMentionTelegramUserIds.length === 0
          ? {}
          : { telegramProfileMentionUserIds: input.profileSignals.explicitMentionTelegramUserIds }),
        ...(input.profileSignals.replyTelegramUserId === null
          ? {}
          : { telegramProfileReplyUserId: input.profileSignals.replyTelegramUserId }),
        ...(input.profileReplyTimelineSequence === null
          ? {}
          : { telegramProfileReplyTimelineSequence: input.profileReplyTimelineSequence }),
        telegramTurnStartedAt: input.turnStartedAt.toISOString(),
        ...(input.message.messageThreadId === undefined
          ? {}
          : { telegramMessageThreadId: String(input.message.messageThreadId) }),
        ...(input.message.chat.type === "private"
          ? {}
          : { telegramReplyToMessageId: input.message.messageId }),
        ...(input.turnContext.omittedBeforeSequence === null
          ? {}
          : { telegramTimelineOmittedBeforeSequence: input.turnContext.omittedBeforeSequence }),
        telegramTimelineEntryId: input.timelineEntryId,
        telegramTimelineSequence: input.turnContext.cursorSequence,
        telegramTimelineVisibleEntryIds: input.turnContext.visibleEntryIds,
        ...(input.turnContext.memoryReviewBatchId === undefined
          ? {}
          : { memoryReviewBatchId: input.turnContext.memoryReviewBatchId }),
        ...(input.turnContext.memoryReviewBatchId === undefined
          ? {}
          : { memoryReviewMode: "interactive" }),
        ...(input.turnContext.memoryReviewSourceEntryIds === undefined
          ? {}
          : { memoryReviewSourceEntryIds: input.turnContext.memoryReviewSourceEntryIds }),
        telegramActorId: input.actor.id,
        telegramActorKind: input.actor.kind,
        ...(input.actor.kind === "telegram_user" ? { telegramUserId: input.actor.id } : {}),
        ...(input.group && input.group.type !== "family_private"
          ? { toolAllowlist: input.group.toolAllowlist }
          : {}),
      },
      authenticator: "telegram",
      principalId: input.access.userId ?? input.actor.actorId,
      principalType: input.actor.kind === "telegram_user" ? "user" : "service",
    },
    context,
    continuationToken: input.appSession.continuationToken,
    // File references and observed image content belong to the message, not disposable
    // per-turn retrieval context. Follow-ups must retain what was actually attached/seen.
    message: [
      input.turnContext.durableMessage,
      ...(input.storedAttachments.length > 0
        ? [formatStoredTelegramAttachments(input.storedAttachments)] : []),
      ...(input.imageAnalysis ? [input.imageAnalysis] : []),
    ].join("\n\n"),
    ...(input.replyHandling === undefined ? {} : { replyHandling: input.replyHandling }),
  };
}
