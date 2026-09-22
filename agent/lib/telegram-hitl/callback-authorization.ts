/**
 * Telegram HITL callback authorization boundary.
 *
 * Exports:
 * - `createTelegramHitlCallbackAuthorizer`: builds an independently testable callback guard.
 * - `authorizeTelegramHitlCallback`: production guard backed by durable PostgreSQL claims.
 */
import {
  telegramContinuationToken,
  type TelegramCallbackQuery,
  type TelegramContext,
  type TelegramHitlCallbackResult,
} from "eve/channels/telegram";

import { AppError } from "../app-error.js";
import {
  telegramHitlApprovalRepository,
  type TelegramHitlApprovalRepository,
} from "./approval-repository.js";
import { boundSettledPrompt, settledPromptText } from "./settled-prompt.js";

const CALLBACK_ERRORS = {
  expired:
    "AGENT_APPROVAL_EXPIRED: Это подтверждение уже использовано или больше не действует.",
  forbidden:
    "AGENT_APPROVAL_FORBIDDEN: Подтвердить действие может только пользователь, который его запросил.",
} as const;
const TELEGRAM_MESSAGE_MAX_CHARACTERS = 4_096;

function resolvedApprovalText(result: {
  promptText: string;
  selectedOptionId: string;
  selectedOptionLabel: string;
}): string {
  // Eve присылает `cancel`; прежняя проверка на `deny` не срабатывала и оставляла английский ярлык.
  const resolution = result.selectedOptionId === "approve"
    ? "Решение: Подтверждено.\nДействие передано на выполнение."
    : result.selectedOptionId === "cancel"
    ? "Решение: Отменено.\nДействие не будет выполнено."
    : `Выбран ответ: ${result.selectedOptionLabel}`;
  // Решение уже принято: обещание будущего исполнения снимается, иначе текст противоречит сам себе.
  const settled = settledPromptText(result.promptText);
  const promptLimit = TELEGRAM_MESSAGE_MAX_CHARACTERS - resolution.length - 2;
  const prompt = boundSettledPrompt(settled, promptLimit);
  return `${prompt}\n\n${resolution}`;
}

export function createTelegramHitlCallbackAuthorizer(
  repository: Pick<TelegramHitlApprovalRepository, "claimCallback">,
) {
  return async function authorizeHitlCallback(
    ctx: TelegramContext,
    query: TelegramCallbackQuery,
    _continuationToken: string,
  ): Promise<TelegramHitlCallbackResult> {
    const message = query.message;
    const callbackData = query.data;
    if (!message || !callbackData) {
      await ctx.telegram.answerCallbackQuery({
        callbackQueryId: query.id,
        showAlert: true,
        text: CALLBACK_ERRORS.expired,
      });
      return null;
    }

    // Callback message identity is the exact durable prompt alias; private channel tokens omit it.
    const promptRoute = telegramContinuationToken({
      chatId: message.chat.id,
      conversationId: message.messageId,
      ...(message.messageThreadId === undefined ? {} : { messageThreadId: message.messageThreadId }),
    });
    // The repository atomically binds the exact button, active Eve request, and current DB role.
    const result = await repository.claimCallback({
      baseContinuationToken: promptRoute,
      callbackData,
      callbackQueryId: query.id,
      telegramChatId: message.chat.id,
      telegramMessageId: message.messageId,
      telegramUserId: query.from.id,
    });
    if (result.status === "authorized" && result.replayed) {
      // The prompt was settled by the first handling of this same press; only Eve still needs it.
      return {
        acknowledgementText: "Решение сохранено",
        auth: result.auth,
        continuationToken: result.continuationToken,
        inputResponses: result.requestIds.map((requestId) => ({
          optionId: result.selectedOptionId,
          requestId,
        })),
      };
    }
    if (result.status === "authorized") {
      // The decision is already durable in the repository: a failed cosmetic edit, refused by
      // Telegram or lost on the network, must not stop the delivery to Eve, or the person's retry
      // would find the request already consumed and the turn would never resume.
      try {
        // Replace the exact claimed prompt before Eve resumes; an empty keyboard removes stale buttons.
        const edited = await ctx.telegram.request("editMessageText", {
          chat_id: message.chat.id,
          message_id: Number(message.messageId),
          reply_markup: { inline_keyboard: [] },
          text: resolvedApprovalText(result),
        });
        if (!edited.ok) {
          console.warn(JSON.stringify({
            code: "AGENT_APPROVAL_MESSAGE_FINALIZE_FAILED",
            status: edited.status,
            telegramChatId: message.chat.id,
            telegramMessageId: message.messageId,
          }));
        }
      } catch (error) {
        console.warn(JSON.stringify({
          code: "AGENT_APPROVAL_MESSAGE_FINALIZE_FAILED",
          error: error instanceof Error ? error.name : "unknown",
          telegramChatId: message.chat.id,
          telegramMessageId: message.messageId,
        }));
      }
      // Every request of the prompt is answered in one Eve delivery. Eve 0.40.0 never merges
      // answers that arrive one delivery at a time, so a step with several approvals would stay
      // parked until an unrelated message arrived.
      return {
        acknowledgementText: "Решение сохранено",
        auth: result.auth,
        continuationToken: result.continuationToken,
        inputResponses: result.requestIds.map((requestId) => ({
          optionId: result.selectedOptionId,
          requestId,
        })),
      };
    }

    await ctx.telegram.answerCallbackQuery({
      callbackQueryId: query.id,
      showAlert: true,
      text: CALLBACK_ERRORS[result.status],
    });
    return null;
  };
}

export const authorizeTelegramHitlCallback = createTelegramHitlCallbackAuthorizer(
  telegramHitlApprovalRepository,
);
