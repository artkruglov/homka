/**
 * Verified nested Telegram reply-target projection.
 *
 * Exports:
 * - `TelegramReplyTargetSnapshot`: model-safe text and attribution for an unavailable reply target.
 * - `telegramReplyTargetSnapshot`: validates raw target identity before projecting untrusted text.
 */
import type { TelegramMessage } from "eve/channels/telegram";

export interface TelegramReplyTargetSnapshot {
  contentText: string;
  quotedText?: string;
  senderDisplayName: string | null;
  senderUsername: string | null;
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function exactIdentifier(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return null;
}

function nonEmptyText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length > 0 ? text : null;
}

function senderProjection(target: JsonRecord): {
  senderDisplayName: string | null;
  senderUsername: string | null;
} {
  // Anonymous/channel posts carry the real visible author in sender_chat rather than from.
  const senderChat = record(target.sender_chat);
  const sender = senderChat ?? record(target.from);
  if (!sender) return { senderDisplayName: null, senderUsername: null };
  const senderUsername = nonEmptyText(sender.username);
  const senderDisplayName = senderChat
    ? nonEmptyText(sender.title) ?? senderUsername
    : [nonEmptyText(sender.first_name), nonEmptyText(sender.last_name)]
        .filter((part): part is string => part !== null)
        .join(" ") || senderUsername;
  return { senderDisplayName, senderUsername };
}

export function telegramReplyTargetSnapshot(
  message: Pick<TelegramMessage, "raw" | "replyToMessage">,
): TelegramReplyTargetSnapshot | null {
  const parsedTarget = message.replyToMessage;
  const rawTarget = record(message.raw.reply_to_message);
  if (!parsedTarget || !rawTarget) return null;

  // Eve and raw Telegram identities must agree before nested untrusted content is admitted.
  const rawMessageId = exactIdentifier(rawTarget.message_id);
  const rawChatId = exactIdentifier(record(rawTarget.chat)?.id);
  if (rawMessageId !== parsedTarget.messageId || rawChatId !== parsedTarget.chat.id) return null;

  const contentText = [nonEmptyText(rawTarget.text), nonEmptyText(rawTarget.caption)]
    .filter((part): part is string => part !== null)
    .join("\n");
  if (!contentText) return null;

  const quotedText = nonEmptyText(record(message.raw.quote)?.text);
  return {
    contentText,
    ...(quotedText === null ? {} : { quotedText }),
    ...senderProjection(rawTarget),
  };
}
