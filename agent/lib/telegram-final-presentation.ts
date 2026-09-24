/**
 * Deterministic Telegram final-presentation selection.
 *
 * Exports:
 * - `TelegramChunkPacing`: whether a chunk opens an authored aside or continues immediately.
 * - `TelegramFinalPresentationChunk`: one plain or rich provider-sized delivery unit.
 * - `formatTelegramFinalPresentation`: selects plain text unless supported markup is present.
 * - `TELEGRAM_KEEP_OPEN_DIRECTIVE`: a code-rendered task board is shown in full, not folded.
 *
 * Key construct:
 * - Transport selection depends on authored syntax, not message length or a hidden default.
 * - An authored aside is a separate paced message; a length-driven split never is.
 * - Every authored message passes the length policy on its own.
 */
import { splitTelegramMessageText } from "eve/channels/telegram";

import {
  formatTelegramRichMessages,
  hasTelegramRichDetailsBlock,
} from "./telegram-rich-markdown.js";
import { splitTelegramAuthoredParts, takeTelegramKeepOpen } from "./telegram-authored-split.js";

export type TelegramChunkPacing = "aside" | "immediate";

export interface TelegramFinalPresentationChunk {
  readonly format: "plain" | "rich";
  readonly pacing: TelegramChunkPacing;
  readonly text: string;
}

const RICH_BLOCK_PATTERN = /(?:^|\n)(?:#{2,3}\s|>\s|[-+*]\s|\d+\.\s|- \[[ xX]\]\s|```|\$\$\s*$|---\s*$|\|[^\n]*\|\s*$)/mu;
const GFM_TABLE_DELIMITER_PATTERN = /(?:^|\n)\s*:?-{3,}:?\s*\|\s*:?-{3,}:?(?:\s*\|\s*:?-{3,}:?)*\s*(?:$|\n)/mu;
const RICH_INLINE_PATTERN = /(?:\*\*[^*\n]+\*\*|~~[^~\n]+~~|==[^=\n]+==|\|\|[^|\n]+\|\||`[^`\n]+`|\[[^\]\n]+\]\([^\s)]+\)|<(?:details(?:\s+open)?|summary|u|ins|sub|sup)>|<\/(?:details|summary|u|ins|sub|sup)>)/iu;
const RICH_ITALIC_PATTERN = /(?:^|[^\p{L}\p{N}_])(?:\*[^*\n]+\*|_[^_\n]+_)(?=$|[^\p{L}\p{N}_])/u;
const RICH_MATH_PATTERN = /\$(?:[\\\p{L}][^$\n]*|[^$\n]*[=+*/^_-][^$\n]*)\$(?![\p{L}\p{N}])/u;
const LONG_ANSWER_MAX_CHARACTERS = 600;
// A paragraph that fits as a standalone short answer must not disappear solely because
// details follow it. Keep its wording intact; never invent or truncate a summary.
const LONG_ANSWER_LEAD_MAX_CHARACTERS = LONG_ANSWER_MAX_CHARACTERS;
const LONG_ANSWER_LEAD_MAX_LINES = 2;
const LONG_ANSWER_SUMMARY = "Полный ответ";
/**
 * Доска дел, которую инструмент отдал готовой, показывается целиком: человеку нужен весь список
 * перед глазами, а длина доски это число дел, а не многословие. Директиву ставит код
 * (`task-board.ts`), модель пересылает доску как есть; до человека маркер не доходит.
 */
export { TELEGRAM_KEEP_OPEN_DIRECTIVE } from "./telegram-authored-split.js";

function usesSupportedRichBlockFormatting(markdown: string): boolean {
  return RICH_BLOCK_PATTERN.test(markdown) || GFM_TABLE_DELIMITER_PATTERN.test(markdown);
}

function usesSupportedRichFormatting(markdown: string): boolean {
  return usesSupportedRichBlockFormatting(markdown) ||
    RICH_INLINE_PATTERN.test(markdown) ||
    RICH_ITALIC_PATTERN.test(markdown) ||
    RICH_MATH_PATTERN.test(markdown);
}

function characterLength(value: string): number {
  return Array.from(value).length;
}

/**
 * Long means a wall of text or a structured block (code, table) the owner wants folded. Line,
 * paragraph and list-item counts are not length: a ten-line poem or six short bullets take less
 * screen than one 600-character paragraph and used to hide behind "Полный ответ" anyway.
 */
function isLongAnswer(markdown: string): boolean {
  const structuredBlock = /(?:^|\n)```/u.test(markdown) ||
    /(?:^|\n)\|[^\n]*\|\s*$/mu.test(markdown) ||
    GFM_TABLE_DELIMITER_PATTERN.test(markdown);
  return characterLength(markdown) > LONG_ANSWER_MAX_CHARACTERS || structuredBlock;
}

/** A lead is a short prose paragraph; a column of short lines (verse, a list) is not cut in two. */
function isProseLead(block: string): boolean {
  return characterLength(block) <= LONG_ANSWER_LEAD_MAX_CHARACTERS &&
    block.split("\n").length <= LONG_ANSWER_LEAD_MAX_LINES &&
    !usesSupportedRichBlockFormatting(block);
}

function neutralizeMalformedDetails(markdown: string): string {
  return markdown.replace(
    /```[\s\S]*?(?:```|$)|`[^`\n]*`|<\/?(?:details|summary)(?:\s[^>]*)?>/giu,
    (value) => value.startsWith("`")
      ? value
      : value.replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
  );
}

function collapseLongAnswer(markdown: string): string {
  if (!isLongAnswer(markdown) || hasTelegramRichDetailsBlock(markdown)) return markdown;
  // Invalid details-like HTML is made inert before the valid backend wrapper is introduced.
  const safeMarkdown = /<\/?details(?:\s[^>]*)?>/iu.test(markdown)
    ? neutralizeMalformedDetails(markdown)
    : markdown;
  const blocks = safeMarkdown.split(/\n\s*\n/gu).filter((part) => part.trim().length > 0);
  // The visible lead is every opening short prose paragraph that still fits the short-answer
  // budget together; only the tail folds, and at least one block always stays inside.
  const leadOf = (count: number): string => blocks.slice(0, count).map((part) => part.trim()).join("\n\n");
  let leadCount = 0;
  while (leadCount < blocks.length - 1 && isProseLead(blocks[leadCount]!.trim()) &&
    characterLength(leadOf(leadCount + 1)) <= LONG_ANSWER_LEAD_MAX_CHARACTERS) {
    leadCount += 1;
  }
  const lead = leadOf(leadCount);
  const details = `<details><summary>${LONG_ANSWER_SUMMARY}</summary>\n\n${blocks.slice(leadCount).join("\n\n")}\n\n</details>`;
  return leadCount > 0 ? `${lead}\n\n${details}` : details;
}

function formatPart(
  markdown: string,
  pacing: TelegramChunkPacing,
): TelegramFinalPresentationChunk[] {
  // Only the opening chunk carries the pause: a provider-sized overflow is the same utterance.
  const chunkPacing = (index: number): TelegramChunkPacing => index === 0 ? pacing : "immediate";

  // Plain text uses Telegram's ordinary 4096-character transport and never receives parse mode.
  if (!usesSupportedRichFormatting(markdown)) {
    return splitTelegramMessageText(markdown)
      .map((text, index) => ({ format: "plain", pacing: chunkPacing(index), text }));
  }
  return formatTelegramRichMessages(markdown)
    .map((text, index) => ({ format: "rich", pacing: chunkPacing(index), text }));
}

export function formatTelegramFinalPresentation(
  markdown: string,
): TelegramFinalPresentationChunk[] {
  const normalized = markdown.trim();
  if (!normalized) return [];
  const { asides, main } = splitTelegramAuthoredParts(normalized);
  if (!main) return [];

  // The length policy applies to each authored message on its own, so a long main answer still
  // collapses without swallowing the asides its author separated from it.
  // Директива действует только отдельной первой строкой части: иначе процитированное название
  // дела с этим текстом отменяло бы кат всему сообщению.
  const present = (part: string) => {
    const { kept, text } = takeTelegramKeepOpen(part);
    return kept ? text : collapseLongAnswer(part);
  };
  return [
    ...formatPart(present(main), "immediate"),
    ...asides.flatMap((aside) => formatPart(present(aside), "aside")),
  ];
}
