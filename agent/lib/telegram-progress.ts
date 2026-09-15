/**
 * Telegram delivery policy for completed model messages.
 *
 * Exports:
 * - `CompletedTelegramOutput`: final message, silent reaction, or interim progress decision.
 * - `completedTelegramOutput`: validates model output before Telegram delivery.
 *
 * Provider adapters route typed reasoning parts to dedicated Eve events that this delivery
 * policy never receives.
 */
import { AppError } from "./app-error.js";
import { extractMemoryUsedDirective } from "./memory-used-directive.js";
import { stripTelegramAsideDirectives } from "./telegram-authored-split.js";
import {
  isTelegramMessageReactionEmoji,
  nearestTelegramReactionEmoji,
  type TelegramMessageReactionEmoji,
} from "./telegram-message-reaction.js";

const TOOL_CALLS_FINISH_REASON = "tool-calls";
const TELEGRAM_REACTION_DIRECTIVE_PATTERN =
  /^<telegram-reaction>(?<emoji>[^<]*)<\/telegram-reaction>$/u;
const TELEGRAM_REACTION_DIRECTIVE_FRAGMENT = "telegram-reaction";
/**
 * The model's explicit way to say nothing. A genuinely empty answer is not available to it: Eve
 * retries an empty model step once, and the retry came back as a placeholder such as "(пусто)"
 * that went to the chat as a message. The directive is transport syntax and never reaches anyone.
 */
export const TELEGRAM_SILENT_DIRECTIVE = "<telegram-silent>";

// DeepSeek's native tool-call markup (`<｜DSML｜calls>` … `</｜DSML｜calls>`). A model that writes
// a call as text instead of a function call must not reach the chat with it: the span from the
// first to the last such tag is dropped and logged, the words around it stay.
const TOOL_MARKUP_TAG_PATTERN = /<\/?[｜|]+\s*DSML\s*[｜|]+[^>]*>/gu;

function stripLeakedToolMarkup(text: string): string {
  const tags = [...text.matchAll(TOOL_MARKUP_TAG_PATTERN)];
  if (tags.length === 0) return text;
  const first = tags[0]!.index;
  const last = tags.at(-1)!;
  const stripped = `${text.slice(0, first)}${text.slice(last.index + last[0].length)}`.replace(/\n{3,}/gu, "\n\n").trim();
  console.warn(JSON.stringify({ code: "AGENT_MODEL_TOOL_MARKUP_LEAKED", removedChars: text.length - stripped.length, tags: tags.length }));
  return stripped;
}

export type CompletedTelegramOutput =
  | { emoji: TelegramMessageReactionEmoji; kind: "reaction" }
  | { kind: "message"; memoryUsedDeclared: boolean; memoryUsedRefs: string[]; message: string }
  | { kind: "progress"; message: string };

export function completedTelegramOutput(data: {
  finishReason: string;
  message?: string | null;
}): CompletedTelegramOutput | null {
  // Only completed visible assistant text should become a durable Telegram message.
  const raw = stripLeakedToolMarkup(
    data.message === undefined || data.message === null ? "" : data.message.trim(),
  );
  // The memory-used directive is bookkeeping for the final answer; it never reaches Telegram.
  const { declared: memoryUsedDeclared, memoryRefs: memoryUsedRefs, message: spoken } = extractMemoryUsedDirective(raw);
  // Silence wins only when it is all the model said; text next to the directive is the answer.
  const message = spoken.split(TELEGRAM_SILENT_DIRECTIVE).join("").trim();
  if (!message) {
    // The directive instead of an answer means the person gets nothing; count it, silence is deliberate.
    if (memoryUsedDeclared && !raw.includes(TELEGRAM_SILENT_DIRECTIVE)) console.warn(JSON.stringify({ code: "AGENT_MEMORY_USED_DIRECTIVE_ONLY" }));
    return null;
  }

  // Text authored before a tool call is what a person reads while a long task runs.
  if (data.finishReason === TOOL_CALLS_FINISH_REASON) {
    const progress = stripTelegramAsideDirectives(message);
    // Transport directives belong to the final answer; interim noise is dropped, never delivered.
    if (!progress || progress.includes(TELEGRAM_REACTION_DIRECTIVE_FRAGMENT)) return null;
    return { kind: "progress", message: progress };
  }

  // Reaction is a terminal transport directive and can never be mixed with user-visible text.
  const reaction = TELEGRAM_REACTION_DIRECTIVE_PATTERN.exec(message)?.groups?.emoji;
  if (reaction !== undefined && isTelegramMessageReactionEmoji(reaction)) {
    // Telegram refuses reactions outside its set with 400, and a refused reaction left the person
    // with nothing (9 сентября 2026). The gesture arrives as the closest reaction Telegram takes.
    const emoji = nearestTelegramReactionEmoji(reaction);
    if (emoji !== reaction.replace(/\uFE0F/gu, "")) {
      console.warn(JSON.stringify({ code: "AGENT_TELEGRAM_REACTION_SUBSTITUTED", applied: emoji, requested: reaction }));
    }
    return { emoji, kind: "reaction" };
  }
  if (message.includes(TELEGRAM_REACTION_DIRECTIVE_FRAGMENT)) {
    throw new AppError(
      "AGENT_TELEGRAM_REACTION_DIRECTIVE_INVALID",
      "Не удалось выбрать безопасную реакцию на сообщение",
    );
  }
  // An answer made of transport directives alone has no visible content to deliver.
  if (!stripTelegramAsideDirectives(message)) return null;
  return { kind: "message", memoryUsedDeclared, memoryUsedRefs, message };
}
