/**
 * Trusted workspace authorization context.
 *
 * Export:
 * - `requireWorkspaceAuthorization`: derives scope identity only from verified Eve auth.
 * - `requireTelegramDeliveryTarget`: resolves only the current verified chat and topic.
 */
import type { SessionContext } from "eve/context";

import { AppError } from "../app-error.js";
import { resolveSessionCaller } from "../session-auth.js";
import { readSpaceAttributes } from "../spaces/space-attributes.js";
import type { WorkspaceAuthorization } from "./workspace-repository.js";

const GROUP_CHAT_TYPES = ["group", "supergroup"];

// Another bot's message starts an external-group turn as the service principal `telegram-bot:<id>`.
// It owns nothing, but the turn still materializes group skills into the group sandbox, and the
// scoped file tools resolve the same group workspace: without this branch the sandbox `onSession`
// threw and the whole session failed before the model ran.
function isExternalBotCaller(
  caller: { principalId: string; principalType: string },
  role: unknown,
  chatType: unknown,
): boolean {
  return caller.principalType === "service" &&
    caller.principalId.startsWith("telegram-bot:") &&
    role === "external" &&
    GROUP_CHAT_TYPES.includes(String(chatType));
}

export function requireWorkspaceAuthorization(
  ctx: Pick<SessionContext, "session">,
): WorkspaceAuthorization {
  const caller = resolveSessionCaller(ctx) ?? ctx.session.auth.current;
  const attributes = caller?.attributes;
  const role = attributes?.role;
  const chatType = attributes?.telegramChatType;
  if (
    caller?.authenticator !== "telegram" ||
    (caller.principalType !== "user" && !isExternalBotCaller(caller, role, chatType)) ||
    typeof attributes?.familyId !== "string" ||
    !["group", "private", "supergroup"].includes(String(chatType)) ||
    !["external", "member", "owner", "recovery_owner"].includes(String(role))
  ) {
    throw new AppError(
      "AGENT_WORKSPACE_CONTEXT_INVALID",
      "Не удалось определить область доступа к файлам",
    );
  }
  const space = readSpaceAttributes(attributes, "AGENT_WORKSPACE_CONTEXT_INVALID");
  return {
    ...(space ? { space } : {}),
    familyId: attributes.familyId,
    groupId: typeof attributes.groupId === "string" ? attributes.groupId : null,
    groupType: ["external", "family_private"].includes(
      String(attributes.groupType),
    )
      ? attributes.groupType as WorkspaceAuthorization["groupType"]
      : null,
    role: role as WorkspaceAuthorization["role"],
    telegramChatType: chatType as WorkspaceAuthorization["telegramChatType"],
    userId: role === "external" ? null : caller.principalId,
  };
}

export function requireTelegramDeliveryTarget(
  ctx: Pick<SessionContext, "session">,
): { chatId: string; messageThreadId?: number } {
  const caller = resolveSessionCaller(ctx) ?? ctx.session.auth.current;
  const chatId = caller?.attributes.telegramChatId;
  const rawThreadId = caller?.attributes.telegramMessageThreadId;
  if (caller?.authenticator !== "telegram" || typeof chatId !== "string") {
    throw new AppError(
      "AGENT_TELEGRAM_DELIVERY_TARGET_INVALID",
      "Не удалось определить Telegram-чат для отправки файла",
    );
  }
  if (rawThreadId === undefined) return { chatId };
  const messageThreadId = Number(rawThreadId);
  if (!Number.isSafeInteger(messageThreadId) || messageThreadId <= 0) {
    throw new AppError(
      "AGENT_TELEGRAM_DELIVERY_TARGET_INVALID",
      "Не удалось определить тему Telegram для отправки файла",
    );
  }
  return { chatId, messageThreadId };
}
