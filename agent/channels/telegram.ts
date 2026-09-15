/**
 * Eve Telegram channel.
 *
 * Constructs:
 * - Verified webhook transport with durable PostgreSQL ingress.
 * - Application-owned family/group authorization in `onMessage`.
 * - Durable identity-bound HITL callbacks and replies.
 * - Validated attachment persistence with model-safe workspace references.
 * - Completed ordinary/Rich Message or silent reaction delivery without speculative chat drafts.
 * - Interim progress notices delivered at most once per assistant step of an interactive turn.
 * - Scheduled final delivery bound to its owner-approved Telegram chat and forum topic.
 * - Verified group replies anchored to the triggering member message.
 * - Successfully delivered final group output persisted as one logical timeline entry.
 */
import { setTimeout as sleep } from "node:timers/promises";

import { telegramChannel } from "eve/channels/telegram";

import { handleTelegramDurableIngress } from "../lib/telegram-durable-ingress.js";
import { formatTelegramTurnFailure, isUnrecoverableHistoryFailure } from "../lib/telegram-interface.js";
import { TELEGRAM_EVE_UPLOAD_POLICY } from "../lib/telegram-message-policy.js";
import { handleTelegramMessage } from "../lib/telegram-on-message.js";
import { completedTelegramOutput } from "../lib/telegram-progress.js";
import { deliverTelegramProgressNotice } from "../lib/telegram-progress-notice.js";
import { progressNoticeKey, telegramProgressNoticeDeferral } from "../lib/telegram-progress-deferral.js";
import { refreshTelegramReactionPolicy } from "../lib/telegram-reaction-policy.js";
import {
  telegramAudienceWatch,
  type TelegramCountRequest,
} from "../lib/spaces/telegram-audience-watch.js";
import {
  authorizeSpaceDelivery,
  notifySuspendedDelivery,
  spaceDeliveryRequestFromAuth,
} from "../lib/spaces/space-delivery-authorization.js";
import { asidePauseMilliseconds } from "../lib/telegram-aside-pacing.js";
import { stripTelegramAsideDirectives } from "../lib/telegram-authored-split.js";
import {
  deliverTelegramFinalOutput,
  suspendTelegramFinalOutput,
} from "../lib/telegram-final-delivery.js";
import { memoryReviewOwnerAlertTransport } from "../lib/memory-review/memory-review-owner-alert-transport.js";
import { telegramFinalDeliveryRepository } from "../lib/telegram-final-delivery-repository.js";
import { postTelegramRichMessageChunk } from "../lib/telegram-rich-messages.js";
import { postTelegramPlainMessageChunk } from "../lib/telegram-plain-messages.js";
import {
  applicationSessionId,
  registerTelegramDeliveredMessageRoutes,
} from "../lib/sessions/session-context.js";
import { sessionRepository } from "../lib/sessions/session-repository.js";
import { groupTimelineCursorRepository } from "../lib/sessions/group-timeline-cursor-repository.js";
import { authorizeTelegramHitlCallback } from "../lib/telegram-hitl/callback-authorization.js";
import { handleTelegramInputRequested } from "../lib/telegram-hitl/input-request.js";
import { telegramHitlApprovalRepository } from "../lib/telegram-hitl/approval-repository.js";
import {
  handleTelegramSessionFailure,
} from "../lib/telegram-session-failure.js";
import { telegramTurnReplyParameters } from "../lib/telegram-reply.js";
import { agentScheduleDispatchRepository } from "../lib/agent-schedules/agent-schedule-dispatch-repository.js";
import {
  isScheduledSession,
  scheduledDeliveryMetadata,
} from "../lib/agent-schedules/scheduled-session.js";
import {
  requireScheduledTelegramTarget,
  SCHEDULED_TELEGRAM_TARGET_MISMATCH_CODE,
  scheduledTelegramTargetMatches,
} from "../lib/agent-schedules/scheduled-telegram-target.js";
import { proactiveDeliveryRepository } from "../lib/proactive-deliveries/proactive-delivery-repository.js";
import { telegramGroupJournalRepository } from "../lib/telegram-group-journal-repository.js";
import { postTelegramMessageWithoutContinuationChange } from "../lib/telegram-stable-delivery.js";
import { shouldNotifyTelegramFailure } from "../lib/telegram-failure-notification.js";
import { AppError, isAppError } from "../lib/app-error.js";
import { conversationTimelineRepository } from "../lib/conversation-timeline-repository.js";
import { setTelegramMessageReaction } from "../lib/telegram-message-reaction.js";
import {
  bindMemoryTurnSources,
  releaseMemoryTurnSources,
} from "../lib/memory-turn-source.js";
import { memoryReviewBatchId } from "../lib/memory-review/memory-review-session.js";
import { resolveMemoryReviewBatch } from "../lib/memory-review/memory-review-turn-binding.js";
import { memoryReviewRepository } from "../lib/memory-review/memory-review-repository.js";
import { memoryReviewDispatchRepository } from "../lib/memory-review/memory-review-dispatch-repository.js";
import { isTelegramChannelSession } from "../lib/telegram-session-actor.js";
import { reinforceUsedMemories } from "../lib/memory-used-reinforcement.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/** Счётчик участников спрашивают не чаще раза в минуту и только у чата с доказанной аудиторией. */
async function watchTelegramAudience(
  channel: { telegram: { chatId: string; request: TelegramCountRequest } },
  ctx: { session: { auth: { current: Parameters<typeof spaceDeliveryRequestFromAuth>[0] } } },
): Promise<void> {
  const attributes = ctx.session.auth.current?.attributes;
  const familyId = attributes?.familyId;
  const groupId = attributes?.groupId;
  if (typeof familyId !== "string" || typeof groupId !== "string") return;
  try {
    await telegramAudienceWatch(channel.telegram.request)({
      familyId, groupId, now: new Date(), telegramChatId: channel.telegram.chatId,
    });
  } catch (error) {
    // Сверка это наблюдение, а не право: её сбой не должен ронять ход. Разрешение всё равно
    // истечёт само по окну свежести, если счётчик перестал отвечать.
    console.error(JSON.stringify({
      code: "AGENT_SPACE_AUDIENCE_WATCH_FAILED",
      errorName: error instanceof Error ? error.name : "UnknownError",
    }));
  }
}

/** Отбивка несёт текст модели, поэтому её аудитория проверяется тем же швом, что и ответ. */
async function deliveryAllowed(
  ctx: { session: { auth: { current: Parameters<typeof spaceDeliveryRequestFromAuth>[0] } } },
): Promise<boolean> {
  const request = spaceDeliveryRequestFromAuth(ctx.session.auth.current, new Date());
  if (request === null) return true;
  return (await authorizeSpaceDelivery(request)).allowed;
}

export default telegramChannel({
  botUsername: process.env.TELEGRAM_BOT_USERNAME as string,
  credentials: {
    webhookSecretToken: process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN as string,
  },
  drainRoute: "/eve/v1/telegram-drain",
  // Durable ingress is FIFO; a later update must never cancel a paid or side-effecting active turn.
  turnPolicy: "queue",
  events: {
    async "input.requested"(data, channel, ctx) {
      // The confirmation prompt is this step's visible reply; text the model wrote next to the
      // gated call would otherwise follow the prompt and repeat what the resumed turn says.
      telegramProgressNoticeDeferral.discard(progressNoticeKey(ctx.session.id, ctx.session.turn.id));
      if (isTelegramChannelSession(ctx.session.auth)) {
        throw new AppError(
          "AGENT_TELEGRAM_CHANNEL_APPROVAL_FORBIDDEN",
          "Сообщение от имени канала не может подтверждать действия. Напишите от личного аккаунта",
        );
      }
      return await handleTelegramInputRequested(data, channel, ctx);
    },
    async "message.completed"(data, channel, ctx) {
      // Model-authored pre-tool text is a user-visible progress update, not technical tool noise.
      if (isScheduledSession(ctx) && data.finishReason !== "stop") return;
      const output = completedTelegramOutput(data);
      if (!output) return;
      const sessionId = applicationSessionId(ctx);
      if (!await sessionRepository.isCurrentEveSession(sessionId, ctx.session.id)) return;
      const noticeKey = progressNoticeKey(ctx.session.id, ctx.session.turn.id);
      if (output.kind === "progress") {
        // Отбивка несёт текст модели, значит это содержимое области: неподтверждённая аудитория
        // просто не получает её. Проверка стоит здесь, а не в самой отбивке: та глушит ошибки.
        if (!await deliveryAllowed(ctx)) {
          telegramProgressNoticeDeferral.discard(noticeKey);
          return;
        }
        // Held until the step names its tools: an answer written beside `remember` must not go
        // out twice, while text before a slow tool still reaches the person at once.
        telegramProgressNoticeDeferral.hold(noticeKey, {
          send: () => deliverTelegramProgressNotice({
            applicationSessionId: sessionId,
            channel,
            eveSessionId: ctx.session.id,
            eveTurnId: ctx.session.turn.id,
            message: output.message,
            stepIndex: data.stepIndex,
          }),
          stepIndex: data.stepIndex,
        });
        return;
      }
      telegramProgressNoticeDeferral.discard(noticeKey);
      const currentAttributes = ctx.session.auth.current?.attributes;
      const scheduledDelivery = scheduledDeliveryMetadata(ctx);
      if (output.kind === "reaction") {
        const telegramMessageId = currentAttributes?.telegramMessageId;
        if (isScheduledSession(ctx) || typeof telegramMessageId !== "string") {
          throw new AppError(
            "AGENT_TELEGRAM_REACTION_TARGET_MISSING",
            "Не удалось определить сообщение для реакции. Отправьте обращение ещё раз",
          );
        }
        // A declined reaction stays silent: a text emoji is not a reaction (owner's decision).
        await setTelegramMessageReaction(channel.telegram, telegramMessageId, output.emoji);
        return;
      }
      const message = output.message;
      const replyParameters = isScheduledSession(ctx)
        ? undefined
        : telegramTurnReplyParameters(channel.state, ctx);
      const durableText = stripTelegramAsideDirectives(message);
      const deliveryIdentity = {
        chatId: channel.telegram.chatId,
        messageThreadId: channel.telegram.messageThreadId ?? null,
        replyParameters: replyParameters ?? null,
      };
      const deliveryMarkdown = isScheduledSession(ctx) ? durableText : message;
      // Несовпавшая цель — нарушение контракта, а не вопрос об аудитории: она падает первой и до
      // любых обращений к базе.
      if (scheduledDelivery) requireScheduledTelegramTarget(channel.telegram, scheduledDelivery);
      // Право инициатора и адресат сообщения — разные проверки. Эта стоит раньше заявки на
      // отправку: приостановка, оставившая `status='started'`, сделала бы любой повтор
      // неизвестным исходом вместо честного отказа. Отпечаток приостановки обязан совпадать с
      // отпечатком отправки, иначе повтор не узнает свою строку.
      const deliveryRequest = spaceDeliveryRequestFromAuth(ctx.session.auth.current, new Date());
      const audience = deliveryRequest === null
        ? { allowed: true as const }
        : await authorizeSpaceDelivery(deliveryRequest);
      if (!audience.allowed) {
        await suspendTelegramFinalOutput({
          applicationSessionId: sessionId,
          deliveryIdentity,
          diagnosticCode: audience.code,
          eveSessionId: ctx.session.id,
          eveTurnId: ctx.session.turn.id,
          markdown: deliveryMarkdown,
        });
        console.error(JSON.stringify({
          code: "AGENT_SPACE_DELIVERY_SUSPENDED",
          reason: audience.code,
          telegramChatId: channel.telegram.chatId,
        }));
        // Приостановленный запуск расписания обязан закрыться сам: иначе его строка осталась бы
        // `running`, аренда расписания — вечной, и следующее вхождение не наступило бы никогда.
        if (scheduledDelivery) {
          await agentScheduleDispatchRepository.failRun(
            sessionId, ctx.session.id, audience.code, new Date(),
          );
        }
        const familyId = ctx.session.auth.current?.attributes.familyId;
        if (typeof familyId === "string") {
          await notifySuspendedDelivery({
            code: audience.code,
            deliver: (notice) => memoryReviewOwnerAlertTransport.deliver(notice),
            familyId,
            telegramChatId: channel.telegram.chatId,
          });
        }
        return;
      }
      if (scheduledDelivery) {
        // Database authorization is meaningful only when it protects the exact active side-effect target.
        await agentScheduleDispatchRepository.authorizeDelivery({
          applicationSessionId: sessionId,
          eveSessionId: ctx.session.id,
          familyId: scheduledDelivery.familyId,
          groupId: scheduledDelivery.groupId,
          messageThreadId: scheduledDelivery.messageThreadId,
          ownerUserId: scheduledDelivery.ownerUserId,
          runId: scheduledDelivery.runId,
          scope: scheduledDelivery.scope,
          telegramChatId: scheduledDelivery.telegramChatId,
        });
      }
      let sentMessages: Awaited<ReturnType<typeof deliverTelegramFinalOutput>>;
      try {
        sentMessages = await deliverTelegramFinalOutput({
          applicationSessionId: sessionId,
          deliveryIdentity,
          eveSessionId: ctx.session.id,
          eveTurnId: ctx.session.turn.id,
          markdown: deliveryMarkdown,
          sendChunk: async (chunk, ordinal) => {
            // An authored aside is a second thought, so it arrives after a visible typing pause.
            if (chunk.pacing === "aside") {
              await channel.telegram.startTyping();
              await sleep(asidePauseMilliseconds(chunk.text));
            }
            return chunk.format === "plain"
              ? await postTelegramPlainMessageChunk(
                  chunk.text,
                  channel,
                  ordinal === 0 ? replyParameters : undefined,
                )
              : await postTelegramRichMessageChunk(
                  chunk.text,
                  channel.telegram,
                  channel.state,
                  ordinal === 0 ? replyParameters : undefined,
                );
          },
        });
      } catch (error) {
        if (scheduledDelivery) {
          const errorCode = isAppError(error)
            ? error.code
            : "AGENT_TELEGRAM_FINAL_DELIVERY_FAILED";
          console.error(JSON.stringify({
            code: "AGENT_SCHEDULE_FINAL_DELIVERY_FAILED",
            deliveryErrorCode: errorCode,
            errorName: error instanceof Error ? error.name : "UnknownError",
            runId: scheduledDelivery.runId,
          }));
          try {
            await agentScheduleDispatchRepository.failRun(
              sessionId,
              ctx.session.id,
              errorCode,
              new Date(),
            );
          } catch (persistenceError) {
            // Terminal persistence is secondary: log it without replacing the actionable delivery error.
            console.error(JSON.stringify({
              code: "AGENT_SCHEDULE_FINAL_DELIVERY_FAILURE_PERSISTENCE_FAILED",
              deliveryErrorCode: errorCode,
              errorName: persistenceError instanceof Error ? persistenceError.name : "UnknownError",
              runId: scheduledDelivery.runId,
            }));
          }
        }
        throw error;
      }
      const deliveredAt = new Date();
      const groupId = scheduledDelivery?.groupId ??
        (typeof currentAttributes?.groupId === "string" ? currentAttributes.groupId : null);
      if (scheduledDelivery) {
        const firstMessage = sentMessages[0];
        if (!firstMessage) {
          throw new Error(
            "AGENT_SCHEDULE_DELIVERY_CONFIRMATION_MISSING: Telegram не подтвердил доставку результата расписания",
          );
        }
        await agentScheduleDispatchRepository.completeDeliveredRun({
          applicationSessionId: sessionId,
          content: durableText,
          deliveredAt,
          eveSessionId: ctx.session.id,
          familyId: scheduledDelivery.familyId,
          groupId: scheduledDelivery.groupId,
          messageThreadId: scheduledDelivery.messageThreadId,
          ownerUserId: scheduledDelivery.ownerUserId,
          runId: scheduledDelivery.runId,
          scheduledFor: new Date(scheduledDelivery.scheduledFor),
          scope: scheduledDelivery.scope,
          telegramChatId: scheduledDelivery.telegramChatId,
          telegramMessageId: firstMessage.messageId,
          title: scheduledDelivery.title,
        });
      }
      const conversationId = typeof currentAttributes?.telegramConversationId === "string"
        ? currentAttributes.telegramConversationId
        : null;
      if ((conversationId || groupId) && data.finishReason === "stop") {
        const replyToEntryId = typeof currentAttributes?.telegramTimelineEntryId === "string"
          ? currentAttributes.telegramTimelineEntryId
          : null;
        const forumTopicId = scheduledDelivery?.forumTopicId ??
          (typeof currentAttributes?.telegramForumTopicId === "string"
            ? currentAttributes.telegramForumTopicId
            : null);
        // The primary delivery receipt is durable before this secondary conversation projection.
        if (groupId) {
          await telegramGroupJournalRepository.recordAgentResponse({
            applicationSessionId: isScheduledSession(ctx) ? null : sessionId,
            contentText: durableText,
            deliveredAt,
            groupId,
            messageThreadId: forumTopicId,
            replyToEntryId,
            telegramMessageIds: sentMessages.map((sent) => sent.messageId),
          });
        } else if (conversationId) {
          await conversationTimelineRepository.recordAgentResponse({
            applicationSessionId: sessionId,
            contentText: durableText,
            conversationId,
            deliveredAt,
            messageThreadId: null,
            replyToEntryId,
            telegramMessageIds: sentMessages.map((sent) => sent.messageId),
          });
        }
      }
      if (!isScheduledSession(ctx)) {
        await registerTelegramDeliveredMessageRoutes(
          channel,
          ctx,
          sentMessages.map((sent) => sent.messageId),
        );
        // The delivered answer named the records it relied on; only refs shown this turn count.
        await reinforceUsedMemories({
          applicationSessionId: sessionId,
          ctx,
          declared: output.memoryUsedDeclared ?? false,
          memoryRefs: output.memoryUsedRefs ?? [],
        });
      }
    },
    async "session.failed"(data, channel) {
      const failureRepository = {
        async recordSessionFailedByContinuationToken(
          continuationToken: string,
          eveSessionId: string,
        ) {
          return await memoryReviewDispatchRepository.markInteractiveSessionAmbiguous({
            continuationToken,
            diagnosticCode: "AGENT_MEMORY_REVIEW_SESSION_FAILED_AMBIGUOUS",
            eveSessionId,
          }) ?? await sessionRepository.recordSessionFailedByContinuationToken(
            continuationToken,
            eveSessionId,
          );
        },
      };
      await handleTelegramSessionFailure(
        data,
        channel,
        failureRepository,
        agentScheduleDispatchRepository,
      );
    },
    async "actions.requested"(data, _channel, ctx) {
      await telegramProgressNoticeDeferral.release(
        progressNoticeKey(ctx.session.id, ctx.session.turn.id),
        data.stepIndex,
        data.actions.map((action) => action.kind === "tool-call"
          ? action.toolName
          : action.kind === "load-skill" ? "load_skill" : action.kind),
      );
    },
    async "turn.failed"(data, channel, ctx) {
      telegramProgressNoticeDeferral.forget(progressNoticeKey(ctx.session.id, ctx.session.turn.id));
      // Terminal failure releases the temporary timeline retention after all tool writes have stopped.
      await releaseMemoryTurnSources(ctx);
      const reviewBatchId = await resolveMemoryReviewBatch(ctx);
      let reviewFailureReplayed = false;
      if (reviewBatchId) {
        const terminal = await memoryReviewRepository.failRunning({
          batchId: reviewBatchId,
          diagnosticCode: data.code,
          eveSessionId: ctx.session.id,
          eveTurnId: ctx.session.turn.id,
        });
        reviewFailureReplayed = terminal === "replayed";
      }
      const sessionId = applicationSessionId(ctx);
      const scheduledDelivery = scheduledDeliveryMetadata(ctx);
      // The durable terminal replay still performs cleanup, but never duplicates a user message.
      let notifyFailure = !reviewFailureReplayed;
      if (scheduledDelivery) {
        const failedAt = new Date();
        if (!scheduledTelegramTargetMatches(channel.telegram, scheduledDelivery)) {
          // Never notify a target that was not approved for this run; close it without Telegram I/O.
          console.error(JSON.stringify({
            activeTelegramChatId: channel.telegram.chatId,
            activeTelegramMessageThreadId: channel.telegram.messageThreadId ?? null,
            code: SCHEDULED_TELEGRAM_TARGET_MISMATCH_CODE,
            expectedTelegramChatId: scheduledDelivery.telegramChatId,
            expectedTelegramMessageThreadId: scheduledDelivery.messageThreadId,
            runId: scheduledDelivery.runId,
            turnErrorCode: data.code,
          }));
          await agentScheduleDispatchRepository.failRun(
            sessionId,
            ctx.session.id,
            SCHEDULED_TELEGRAM_TARGET_MISMATCH_CODE,
            failedAt,
          );
          notifyFailure = false;
        } else {
          notifyFailure = await agentScheduleDispatchRepository.failRunForNotification(
            {
              applicationSessionId: sessionId,
              eveSessionId: ctx.session.id,
              familyId: scheduledDelivery.familyId,
              groupId: scheduledDelivery.groupId,
              messageThreadId: scheduledDelivery.messageThreadId,
              ownerUserId: scheduledDelivery.ownerUserId,
              runId: scheduledDelivery.runId,
              scope: scheduledDelivery.scope,
              telegramChatId: scheduledDelivery.telegramChatId,
            },
            data.code,
            failedAt,
          );
        }
      }
      // Terminal diagnostics are private-only even when the failed turn belonged to a shared chat.
      notifyFailure = notifyFailure && shouldNotifyTelegramFailure(channel);
      // A final send that started may already be visible; never append a second failure message.
      const finalDeliveryMayBeVisible = notifyFailure &&
        await telegramFinalDeliveryRepository.shouldSuppressFailureMessage(
          ctx.session.id,
          ctx.session.turn.id,
        );
      if (!finalDeliveryMayBeVisible && notifyFailure) {
        const replyParameters = isScheduledSession(ctx)
          ? undefined
          : telegramTurnReplyParameters(channel.state, ctx);
        const failureMessageId = await postTelegramMessageWithoutContinuationChange(channel, {
          ...(replyParameters === undefined ? {} : { reply_parameters: replyParameters }),
          text: formatTelegramTurnFailure(data),
        });
        if (!isScheduledSession(ctx)) {
          await registerTelegramDeliveredMessageRoutes(channel, ctx, [failureMessageId]);
        }
      }
      if (!reviewBatchId) await sessionRepository.recordTurnFailed(sessionId, ctx.session.id);
      // The next message would fail the same way on the same history, so it starts a new session.
      if (!reviewBatchId && isUnrecoverableHistoryFailure(data)) {
        await sessionRepository.requestRotation(sessionId, "history_unrecoverable");
        console.error(JSON.stringify({
          code: "AGENT_SESSION_HISTORY_UNRECOVERABLE",
          applicationSessionId: sessionId,
          eveSessionId: ctx.session.id,
          eveTurnId: ctx.session.turn.id,
        }));
      }
      await telegramHitlApprovalRepository.clearForEveSession(sessionId, ctx.session.id);
    },
    async "turn.cancelled"(_data, _channel, ctx) {
      // Steering by the next chat message is the most common way a turn ends in a live group. The
      // batch used to wait for the time bound instead, while later turns chained onto a head that
      // would never report, so their finished work stayed unreachable from the lane cursor.
      await releaseMemoryTurnSources(ctx);
      const reviewBatchId = await resolveMemoryReviewBatch(ctx);
      if (reviewBatchId) {
        await memoryReviewRepository.failRunning({
          batchId: reviewBatchId,
          diagnosticCode: "AGENT_MEMORY_REVIEW_TURN_CANCELLED",
          eveSessionId: ctx.session.id,
          eveTurnId: ctx.session.turn.id,
        });
      }
      // A cancelled turn is not a failure and its session keeps serving the replacement turn, so
      // only its own approval rows are released here.
      await telegramHitlApprovalRepository.clearForEveSession(
        applicationSessionId(ctx),
        ctx.session.id,
      );
    },
    async "turn.started"(_data, channel, ctx) {
      const sessionId = applicationSessionId(ctx);
      await sessionRepository.bindEveSession(sessionId, ctx.session.id);
      // Which reactions this chat accepts is provider state, so it is refreshed here and read from
      // the database by the prompt resolver. A brand new chat therefore gains the reaction surface
      // from its next turn instead of guessing it now.
      if (!isScheduledSession(ctx)) await refreshTelegramReactionPolicy(channel.telegram);
      // События `chat_member` Eve отбрасывает до приложения, поэтому за составом чата следит
      // счётчик участников: вход и выход он ловит в пределах минуты, а события дали бы только
      // скорость. Расхождение снимает разрешение, и дальше всё уже написанное срабатывает само.
      await watchTelegramAudience(channel, ctx);
      const reviewBatchId = memoryReviewBatchId(ctx);
      if (reviewBatchId) {
        await memoryReviewRepository.bindEveTurn({
          applicationSessionId: sessionId,
          batchId: reviewBatchId,
          eveSessionId: ctx.session.id,
          eveTurnId: ctx.session.turn.id,
        });
      }
      // This immutable snapshot survives every later model/tool/HITL step in the same durable turn.
      await bindMemoryTurnSources(ctx);
      const attributes = ctx.session.auth.current?.attributes;
      const timelineSequence = attributes?.telegramTimelineSequence;
      if (typeof timelineSequence === "string") {
        await groupTimelineCursorRepository.advance(
          sessionId,
          ctx.session.id,
          timelineSequence,
        );
      }
      const proactiveDeliveryCursor = attributes?.proactiveDeliveryCursor;
      if (typeof proactiveDeliveryCursor === "string") {
        await proactiveDeliveryRepository.advanceSessionCursor(
          sessionId,
          proactiveDeliveryCursor,
        );
      }
    },
    async "turn.completed"(_data, channel, ctx) {
      // Text still held here was the answer: the model never wrote again after its quiet tools.
      const noticeKey = progressNoticeKey(ctx.session.id, ctx.session.turn.id);
      await telegramProgressNoticeDeferral.flush(noticeKey);
      telegramProgressNoticeDeferral.forget(noticeKey);
      const sessionId = applicationSessionId(ctx);
      const awaitingApproval = await sessionRepository.hasPendingOperation(sessionId, ctx.session.id);
      const reviewBatchId = await resolveMemoryReviewBatch(ctx);
      if (!awaitingApproval) {
        // Completion verifies review evidence before release; a parked HITL turn retains its source set.
        if (reviewBatchId) {
          await memoryReviewRepository.completeBatch({
            batchId: reviewBatchId,
            completedAt: new Date(),
            eveSessionId: ctx.session.id,
            eveTurnId: ctx.session.turn.id,
          });
        }
        await releaseMemoryTurnSources(ctx);
      }
      if (isScheduledSession(ctx) && !awaitingApproval) {
        // Successful scheduled runs are completed atomically with Telegram delivery above.
        await agentScheduleDispatchRepository.failRun(
          sessionId,
          ctx.session.id,
          "AGENT_SCHEDULE_DELIVERY_CONFIRMATION_MISSING",
          new Date(),
        );
      }
      if (!reviewBatchId) {
        await sessionRepository.recordTurnCompleted(sessionId, ctx.session.id, awaitingApproval);
      }
      if (!awaitingApproval) {
        await telegramHitlApprovalRepository.clearForEveSession(sessionId, ctx.session.id);
      }
    },
    async "authorization.required"(_data, _channel, ctx) {
      if (isTelegramChannelSession(ctx.session.auth)) {
        throw new AppError(
          "AGENT_TELEGRAM_CHANNEL_APPROVAL_FORBIDDEN",
          "Сообщение от имени канала не может подтверждать действия. Напишите от личного аккаунта",
        );
      }
      const sessionId = applicationSessionId(ctx);
      const auth = ctx.session.auth.current;
      const telegramUserId = auth?.attributes.telegramUserId;
      await sessionRepository.parkSession({
        applicationSessionId: sessionId,
        pendingRequestId: null,
        requesterTelegramUserId: typeof telegramUserId === "string" ? telegramUserId : null,
        requesterUserId: auth && UUID_PATTERN.test(auth.principalId) ? auth.principalId : null,
      });
    },
    async "authorization.completed"(_data, _channel, ctx) {
      await sessionRepository.resumePendingSession(applicationSessionId(ctx), ctx.session.id);
    },
  },
  onDrain: handleTelegramDurableIngress.drain,
  onHitlCallbackQuery: authorizeTelegramHitlCallback,
  onMessage: handleTelegramMessage,
  onVerifiedUpdate: handleTelegramDurableIngress,
  // The application persists authorized files before dispatch. The primary model receives only
  // trusted workspace paths and invokes the dedicated vision model when image analysis is needed.
  uploadPolicy: TELEGRAM_EVE_UPLOAD_POLICY,
});
