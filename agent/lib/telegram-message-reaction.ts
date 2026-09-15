/**
 * Telegram current-message reaction delivery.
 *
 * Exports:
 * - `TelegramMessageReactionEmoji`: one model-selected emoji grapheme.
 * - `TelegramMessageReactionResult`: applied or provider-restricted delivery outcome.
 * - `isTelegramMessageReactionEmoji`: strict single-emoji reaction directive guard.
 * - `TELEGRAM_REACTION_EMOJI`: the documented Bot API `ReactionTypeEmoji` set.
 * - `normalizeTelegramReactionEmoji`: canonical member of that set for a model-written emoji, or null.
 * - `nearestTelegramReactionEmoji`: that member, or the closest allowed reaction by mood, else 👍.
 * - `setTelegramMessageReaction`: confirmed Bot API reaction on a verified inbound message.
 */
import type { TelegramHandle } from "eve/channels/telegram";

import { AppError } from "./app-error.js";

const EMOJI_GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const EXTENDED_PICTOGRAPHIC_PATTERN = /\p{Extended_Pictographic}/u;
const KEYCAP_EMOJI_PATTERN = /^[#*0-9]\uFE0F?\u20E3$/u;
const REGIONAL_FLAG_PATTERN = /^\p{Regional_Indicator}{2}$/u;
const TELEGRAM_MESSAGE_ID_PATTERN = /^[1-9]\d*$/u;
const TELEGRAM_REACTION_DECLINED_STATUSES = new Set([400, 403]);
const VARIATION_SELECTOR_PATTERN = /\uFE0F/gu;

/**
 * Bot API `ReactionTypeEmoji.emoji` (core.telegram.org/bots/api, read 9 сентября 2026): Telegram
 * accepts exactly these and answers 400 REACTION_INVALID to anything else, including a cat for
 * «хорошая кошка». Written without U+FE0F, the form the documentation uses; Telegram also takes
 * the selector, so input is compared after stripping it.
 */
export const TELEGRAM_REACTION_EMOJI: readonly string[] = [
  "❤", "👍", "👎", "🔥", "🥰", "👏", "😁", "🤔", "🤯", "😱",
  "🤬", "😢", "🎉", "🤩", "🤮", "💩", "🙏", "👌", "🕊", "🤡",
  "🥱", "🥴", "😍", "🐳", "❤‍🔥", "🌚", "🌭", "💯", "🤣", "⚡",
  "🍌", "🏆", "💔", "🤨", "😐", "🍓", "🍾", "💋", "🖕", "😈",
  "😴", "😭", "🤓", "👻", "👨‍💻", "👀", "🎃", "🙈", "😇", "😨",
  "🤝", "✍", "🤗", "🫡", "🎅", "🎄", "☃", "💅", "🤪", "🗿",
  "🆒", "💘", "🙉", "🦄", "😘", "💊", "🙊", "😎", "👾", "🤷‍♂",
  "🤷", "🤷‍♀", "😡",
];

const TELEGRAM_REACTION_EMOJI_SET = new Set(TELEGRAM_REACTION_EMOJI);

/** The canonical Telegram reaction for a model-written emoji, or null when Telegram would refuse it. */
export function normalizeTelegramReactionEmoji(value: string): TelegramMessageReactionEmoji | null {
  const canonical = value.replace(VARIATION_SELECTOR_PATTERN, "");
  return TELEGRAM_REACTION_EMOJI_SET.has(canonical) ? canonical : null;
}

/**
 * Mood groups for emoji Telegram does not take as reactions. The model asked for an emotion, so the
 * gesture stays a reaction of the same mood (owner's decision: a text emoji is not a reaction).
 * Keyed by the first code point; skin tones, ZWJ sequences and selectors fall to that base.
 */
const REACTION_MOOD_GROUPS: ReadonlyArray<readonly [TelegramMessageReactionEmoji, string]> = [
  ["🥰", "😺😸😹😻😼😽🙀😿😾🐱🐈🐶🐕🐾🥹☺😚😙😗🤗🫂"],
  ["🤣", "😂😆😝😜🤪😹"],
  ["😁", "😀😃😄😊🙂😉😋🙃🫠"],
  ["❤", "💕💖💗💓💞💝💟♥🧡💛💚💙💜🖤🤍🤎❣💌💐🌹🌸💐"],
  ["😢", "😔😞😟🙁☹😥😓😪🥺"],
  ["😭", "😿"],
  ["🤔", "🧐🤨🤔💭"],
  ["😱", "😳😮😯😲🫢😧😦😨"],
  ["🤯", "🫨"],
  ["😡", "😠😤👿💢"],
  ["👏", "🙌👐🤲🫶"],
  ["🤝", "👋✌🤞🫰"],
  ["🎉", "🥳🎊🎈🎁🥂🍻"],
  ["😎", "😏😌🆗"],
  ["🔥", "💥✨⭐🌟"],
  ["🙏", "🛐"],
  ["😴", "😪💤"],
  ["🤮", "🤢🤧😷"],
  ["🤓", "🧠📚"],
  ["🗿", "🪨"],
];

const REACTION_BY_BASE_CODE_POINT = new Map<number, TelegramMessageReactionEmoji>();
for (const [reaction, members] of REACTION_MOOD_GROUPS) {
  for (const member of members) {
    const codePoint = member.codePointAt(0);
    if (codePoint !== undefined && !REACTION_BY_BASE_CODE_POINT.has(codePoint)) {
      REACTION_BY_BASE_CODE_POINT.set(codePoint, reaction);
    }
  }
}
for (const reaction of TELEGRAM_REACTION_EMOJI) {
  const codePoint = reaction.codePointAt(0);
  if (codePoint !== undefined && !REACTION_BY_BASE_CODE_POINT.has(codePoint)) {
    REACTION_BY_BASE_CODE_POINT.set(codePoint, reaction);
  }
}

const DEFAULT_REACTION: TelegramMessageReactionEmoji = "👍";

/** An allowed reaction for any model-written emoji: itself, the closest by mood, else 👍. */
export function nearestTelegramReactionEmoji(value: string): TelegramMessageReactionEmoji {
  const canonical = normalizeTelegramReactionEmoji(value);
  if (canonical !== null) return canonical;
  const codePoint = value.codePointAt(0);
  const byMood = codePoint === undefined ? undefined : REACTION_BY_BASE_CODE_POINT.get(codePoint);
  return byMood ?? DEFAULT_REACTION;
}

export type TelegramMessageReactionResult = "applied" | "unavailable";

export type TelegramMessageReactionEmoji = string;

export function isTelegramMessageReactionEmoji(
  value: string,
): value is TelegramMessageReactionEmoji {
  const graphemes = Array.from(EMOJI_GRAPHEME_SEGMENTER.segment(value));
  return graphemes.length === 1 && graphemes[0]?.segment === value &&
    (EXTENDED_PICTOGRAPHIC_PATTERN.test(value) || KEYCAP_EMOJI_PATTERN.test(value) ||
      REGIONAL_FLAG_PATTERN.test(value));
}

export async function setTelegramMessageReaction(
  telegram: Pick<TelegramHandle, "chatId" | "request">,
  messageId: string,
  emoji: TelegramMessageReactionEmoji,
): Promise<TelegramMessageReactionResult> {
  if (!TELEGRAM_MESSAGE_ID_PATTERN.test(messageId) || !Number.isSafeInteger(Number(messageId))) {
    throw new AppError(
      "AGENT_TELEGRAM_REACTION_TARGET_INVALID",
      "Telegram передал некорректное сообщение для реакции",
    );
  }

  const canonical = normalizeTelegramReactionEmoji(emoji) ?? emoji;
  // The exact channel context and verified inbound message are the only reaction target.
  let response;
  try {
    response = await telegram.request("setMessageReaction", {
      chat_id: telegram.chatId,
      is_big: false,
      message_id: Number(messageId),
      reaction: [{ emoji: canonical, type: "emoji" }],
    });
  } catch (error) {
    console.error(JSON.stringify({
      code: "AGENT_TELEGRAM_REACTION_DELIVERY_FAILED",
      errorName: error instanceof Error ? error.name : "UnknownError",
      method: "setMessageReaction",
    }));
    if (error instanceof Error) {
      Object.defineProperty(error, "message", {
        configurable: true,
        value: `AGENT_TELEGRAM_REACTION_DELIVERY_FAILED: ${error.message}`,
        writable: true,
      });
    }
    throw error;
  }

  const body = response.body as { description?: unknown; ok?: unknown; result?: unknown } | null;
  if (response.ok && body?.ok === true && body.result === true) return "applied";

  // Disabled or restricted chat reactions are an expected presentation limitation, not turn failure.
  if (body?.ok === false && TELEGRAM_REACTION_DECLINED_STATUSES.has(response.status)) {
    console.error(JSON.stringify({
      code: "AGENT_TELEGRAM_REACTION_UNAVAILABLE",
      emoji: canonical,
      method: "setMessageReaction",
      providerDescription: typeof body.description === "string" ? body.description : null,
      providerStatus: response.status,
    }));
    return "unavailable";
  }

  console.error(JSON.stringify({
    code: "AGENT_TELEGRAM_REACTION_DELIVERY_FAILED",
    method: "setMessageReaction",
    providerStatus: response.status,
  }));
  throw new AppError(
    "AGENT_TELEGRAM_REACTION_DELIVERY_FAILED",
    "Telegram не принял реакцию. Проверьте, разрешены ли реакции в этом чате",
  );
}
