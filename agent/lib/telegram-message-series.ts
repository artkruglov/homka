/**
 * Consecutive messages of one author, answered in one turn.
 *
 * A person or another bot often splits one thought into several Telegram messages. The durable
 * ingress claims such a run from the head of a chat queue and dispatches every message through the
 * ordinary handler so the journal keeps its order; only the last message starts a model turn, and
 * it names the earlier sequences so one answer covers the whole run.
 *
 * Exports:
 * - `TELEGRAM_SERIES_MAX_MESSAGES`: bound on messages answered by one turn.
 * - `TelegramSeriesMarker`: application marker carried in the raw message (`context` or `current`).
 * - `isSeriesEligible`: message shapes that may join a series at all.
 * - `continuesSeries`: whether a candidate extends the series started by the head message.
 * - `withSeriesMarker`, `readTelegramSeriesMarker`: marker transport through Eve's parsed update.
 */
import type { TelegramMessage, TelegramUpdate } from "eve/channels/telegram";

import {
  classifyTelegramInboundMedia,
  isReplyToBot,
  isTelegramSlashCommand,
  mentionsAnotherUsername,
} from "./telegram-message-policy.js";

export const TELEGRAM_SERIES_MAX_MESSAGES = 5;
export const TELEGRAM_SERIES_MARKER_KEY = "osinara_series";

export type TelegramSeriesMarker =
  | { role: "context" }
  | { addressed: boolean; role: "current"; telegramMessageIds: string[] };

// Telegram marks forwarded content with one of these keys; a forward is someone else's words.
const FORWARD_KEYS = ["forward_origin", "forward_from", "forward_from_chat", "forward_date"];

export function isSeriesEligible(update: TelegramUpdate, botUsername: string): boolean {
  if (update.kind !== "message") return false;
  const message = update.message;
  if (message.chat.type === "channel") return false;
  // A channel post has no personal sender; voice, media, and forwards keep their own turn.
  if (!message.from || Object.hasOwn(message.raw, "sender_chat")) return false;
  if (Object.hasOwn(message.raw, "voice") || message.attachments.length > 0) return false;
  if (classifyTelegramInboundMedia(message) !== "none") return false;
  if (FORWARD_KEYS.some((key) => Object.hasOwn(message.raw, key))) return false;
  const text = message.text.trim();
  if (!text || isTelegramSlashCommand(text)) return false;
  // Replies and mentions that point at someone other than this bot are that person's thread.
  if (message.replyToMessage && !isReplyToBot(message, botUsername)) return false;
  if (mentionsAnotherUsername(text, botUsername)) return false;
  return true;
}

export function continuesSeries(
  head: TelegramUpdate,
  candidate: TelegramUpdate,
  botUsername: string,
): boolean {
  if (!isSeriesEligible(head, botUsername) || !isSeriesEligible(candidate, botUsername)) {
    return false;
  }
  const first = (head as { message: TelegramMessage }).message;
  const next = (candidate as { message: TelegramMessage }).message;
  return first.chat.id === next.chat.id &&
    (first.messageThreadId ?? null) === (next.messageThreadId ?? null) &&
    first.from?.id === next.from?.id &&
    first.from?.isBot === next.from?.isBot;
}

export function withSeriesMarker(
  update: TelegramUpdate & { kind: "message" },
  marker: TelegramSeriesMarker,
): TelegramUpdate {
  const raw = { ...update.message.raw, [TELEGRAM_SERIES_MARKER_KEY]: marker };
  return { ...update, message: { ...update.message, raw } };
}

export function readTelegramSeriesMarker(raw: Record<string, unknown>): TelegramSeriesMarker | null {
  const value = raw[TELEGRAM_SERIES_MARKER_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const marker = value as Record<string, unknown>;
  if (marker.role === "context") return { role: "context" };
  if (
    marker.role === "current" &&
    typeof marker.addressed === "boolean" &&
    Array.isArray(marker.telegramMessageIds) &&
    marker.telegramMessageIds.every((id) => typeof id === "string" && /^[1-9]\d*$/u.test(id))
  ) {
    return {
      addressed: marker.addressed,
      role: "current",
      telegramMessageIds: marker.telegramMessageIds as string[],
    };
  }
  return null;
}
