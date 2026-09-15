/**
 * Telegram ordinary-reply and HITL authorization boundary.
 *
 * Exports:
 * - `TelegramReplyAuthorizationResult`: accepted routing state for the remaining inbound turn.
 * - `authorizeTelegramReply`: separates channel conversation replies from human HITL approvals.
 *
 * Key constructs:
 * - Only a reply to this bot's own message can be a HITL answer; a reply to another bot stays a
 *   plain message.
 */
import type { TelegramMessage } from "eve/channels/telegram";

import type { TelegramHitlApprovalRepository } from "./telegram-hitl/approval-repository.js";
import type { TelegramInboundActor } from "./telegram-inbound-actor.js";
import { isReplyToBot } from "./telegram-message-policy.js";
import { telegramBaseContinuationToken } from "./telegram-reply-routing.js";

export interface TelegramReplyAuthorizationResult {
  accepted: boolean;
  replyHandling: "message" | undefined;
  resumesPendingTask: boolean;
  verifiedReplyRoute: string | undefined;
}

export async function authorizeTelegramReply(input: {
  actor: TelegramInboundActor;
  botUsername: string;
  exactReplyRoute: string | undefined;
  hasResumableReplyRoute: boolean;
  hitl: Pick<TelegramHitlApprovalRepository, "authorizeReply">;
  message: TelegramMessage;
  replyToAgent: boolean;
  sendMessage(text: string): Promise<unknown>;
  verifiedReplyRoute: string | undefined;
}): Promise<TelegramReplyAuthorizationResult> {
  let replyHandling: "message" | undefined;
  let resumesPendingTask = false;
  let verifiedReplyRoute = input.verifiedReplyRoute;
  const replyTarget = input.message.replyToMessage;

  // A channel or another bot can continue an ordinary group conversation, but neither can ever
  // approve a human action: only a verified person answers a confirmation prompt.
  if ((input.actor.kind === "telegram_channel" || input.actor.kind === "telegram_bot") &&
    (replyTarget?.from?.isBot === true || input.replyToAgent)) {
    if (input.replyToAgent || isReplyToBot(input.message, input.botUsername)) {
      if (!input.hasResumableReplyRoute) verifiedReplyRoute = input.exactReplyRoute;
      replyHandling = "message";
    }
  } else if (
    replyTarget?.from?.isBot === true && !input.replyToAgent &&
    input.message.chat.type !== "private" &&
    typeof replyTarget.from.username === "string" &&
    replyTarget.from.username.toLowerCase() !== input.botUsername.toLowerCase()
  ) {
    // A reply to another bot's message is ordinary conversation. Without this Eve's native path
    // delivered it as a freeform answer to a prompt that never existed: no turn, no boundary,
    // and the drain of that chat waited forever.
    replyHandling = "message";
  } else if (replyTarget?.from?.isBot === true || input.replyToAgent) {
    if (!replyTarget) {
      throw new Error(
        "AGENT_TELEGRAM_REPLY_TARGET_MISSING: Для проверки ответа отсутствует Telegram-сообщение назначения",
      );
    }
    const authorization = await input.hitl.authorizeReply({
      baseContinuationToken: telegramBaseContinuationToken(
        input.message,
        verifiedReplyRoute ?? (input.replyToAgent ? input.exactReplyRoute : undefined),
      ),
      telegramChatId: input.message.chat.id,
      telegramMessageId: replyTarget.messageId,
      telegramUserId: input.actor.id,
    });
    if (authorization === "forbidden" || authorization === "expired") {
      const error = authorization === "forbidden"
        ? "AGENT_APPROVAL_FORBIDDEN: Подтвердить действие может только пользователь, который его запросил."
        : "AGENT_APPROVAL_EXPIRED: Это подтверждение уже использовано или больше не действует.";
      if (input.message.chat.type === "private") await input.sendMessage(error);
      return { accepted: false, replyHandling, resumesPendingTask, verifiedReplyRoute };
    }

    // DB authorization decides synthetic HITL. A verified ordinary reply keeps its conversation route.
    const ordinaryAgentReply = input.replyToAgent || input.message.chat.type === "private" ||
      isReplyToBot(input.message, input.botUsername);
    if (authorization === "not_applicable" && ordinaryAgentReply) {
      if (!input.hasResumableReplyRoute) verifiedReplyRoute = input.exactReplyRoute;
      replyHandling = "message";
    }
    if (authorization === "authorized") resumesPendingTask = true;
  }

  return { accepted: true, replyHandling, resumesPendingTask, verifiedReplyRoute };
}
