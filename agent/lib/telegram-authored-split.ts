/**
 * Authored splitting of one model answer into separate Telegram messages.
 *
 * Exports:
 * - `TELEGRAM_ASIDE_DIRECTIVE`: service line the model writes between spoken parts.
 * - `TelegramAuthoredParts`: main answer plus the authored asides.
 * - `splitTelegramAuthoredParts`: applies the paced-message ceiling and nothing else.
 * - `stripTelegramAsideDirectives`: durable projection text without transport directives.
 * - `TELEGRAM_KEEP_OPEN_DIRECTIVE`, `takeTelegramKeepOpen`: a code-rendered board is shown in full.
 *
 * Key construct:
 * - Where an answer breaks and how each part reads is the author's decision. The ceiling below
 *   limits only how many paced messages one answer can open; a part longer than the Telegram
 *   transport limit is still split further by the presentation layer, as any answer always was.
 * - The directive is transport syntax and never reaches a person: a whole-line directive splits,
 *   any other occurrence is removed. Fenced and indented code keeps its literal content.
 * - The directive looks like an XML tag, so the model sometimes closes it: `</telegram-split>`
 *   reached people as visible text. Closing and self-closing spellings, and the plain `[[split]]`
 *   marker upstream switched to, are the same directive for the transport.
 */
export const TELEGRAM_KEEP_OPEN_DIRECTIVE = "<telegram-keep-open>";

/**
 * Директива признаётся отдельной строкой в любом месте части, а не только первой: 24 сентября
 * 2026 модель предварила доску фразой «Вот твои дела», и доска целиком ушла под кат. Требование
 * «отдельной строкой» остаётся: процитированное в предложении название дела кат не отменяет.
 * Разбор идёт построчно с учётом ограждённого кода, где директива остаётся содержимым примера.
 */
const KEEP_OPEN_LINE_PATTERN = /^[ \t]*<telegram-keep-open>[ \t]*\r?$/u;
const CODE_FENCE_PATTERN = /^\s*```/u;

/** Снимает директиву вне кода и говорит, была ли она там вообще. */
export function takeTelegramKeepOpen(part: string): { kept: boolean; text: string } {
  let kept = false;
  let fenced = false;
  const lines: string[] = [];
  for (const line of part.split("\n")) {
    if (CODE_FENCE_PATTERN.test(line)) fenced = !fenced;
    if (!fenced && KEEP_OPEN_LINE_PATTERN.test(line)) {
      kept = true;
      continue;
    }
    lines.push(line);
  }
  return kept ? { kept, text: lines.join("\n").trim() } : { kept, text: part };
}

const TELEGRAM_AUTHORED_MESSAGE_MAX_COUNT = 5;

export const TELEGRAM_ASIDE_DIRECTIVE = "<telegram-split>";

const DIRECTIVE_SOURCE = "</?telegram-split[ \\t]*/?>|\\[\\[split\\]\\]";
// Column zero only: an indented directive belongs to a Markdown code block, not to the transport.
const DIRECTIVE_LINE_PATTERN = new RegExp(`^(?:${DIRECTIVE_SOURCE})[ \\t\\r]*$`, "u");
const DIRECTIVE_PRESENCE_PATTERN = new RegExp(DIRECTIVE_SOURCE, "u");
const INLINE_DIRECTIVE_PATTERN = new RegExp(DIRECTIVE_SOURCE, "gu");
const FENCE_LINE_PATTERN = /^ {0,3}(?<fence>`{3,}|~{3,})(?<info>.*)$/u;
const INDENTED_CODE_PATTERN = /^(?: {4}|\t)/u;

export interface TelegramAuthoredParts {
  readonly asides: readonly string[];
  readonly main: string;
}

interface FenceState {
  character: string;
  length: number;
}

function nextFenceState(line: string, open: FenceState | null): FenceState | null {
  const match = FENCE_LINE_PATTERN.exec(line);
  if (!match) return open;
  const fence = match.groups?.fence ?? "";
  const info = match.groups?.info ?? "";
  const character = fence[0] ?? "";
  // A closing fence repeats the opening character, is at least as long, and carries no info string.
  if (open) {
    const closes = character === open.character && fence.length >= open.length &&
      info.trim().length === 0;
    return closes ? null : open;
  }
  // Markdown forbids a backtick inside the info string of a backtick fence.
  if (character === "`" && info.includes("`")) return null;
  return { character, length: fence.length };
}

function withoutInlineDirective(line: string): string {
  if (!DIRECTIVE_PRESENCE_PATTERN.test(line) || INDENTED_CODE_PATTERN.test(line)) return line;
  return line.replace(INLINE_DIRECTIVE_PATTERN, "").replace(/[ \t]{2,}/gu, " ").trimEnd();
}

function authoredParts(markdown: string): string[] {
  const parts: string[] = [];
  let current: string[] = [];
  let fence: FenceState | null = null;
  for (const line of markdown.split("\n")) {
    const openFence = fence;
    fence = nextFenceState(line, fence);
    if (openFence || fence) {
      current.push(line);
      continue;
    }
    if (DIRECTIVE_LINE_PATTERN.test(line)) {
      parts.push(current.join("\n"));
      current = [];
      continue;
    }
    current.push(withoutInlineDirective(line));
  }
  parts.push(current.join("\n"));
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

export function splitTelegramAuthoredParts(markdown: string): TelegramAuthoredParts {
  const parts = authoredParts(markdown);
  const main = parts[0];
  if (main === undefined) return { asides: [], main: "" };
  if (parts.length <= TELEGRAM_AUTHORED_MESSAGE_MAX_COUNT) {
    return { asides: parts.slice(1), main };
  }

  // Nothing the author wrote is dropped: everything past the ceiling joins the last message.
  const delivered = [
    ...parts.slice(0, TELEGRAM_AUTHORED_MESSAGE_MAX_COUNT - 1),
    parts.slice(TELEGRAM_AUTHORED_MESSAGE_MAX_COUNT - 1).join("\n\n"),
  ];
  return { asides: delivered.slice(1), main: delivered[0]! };
}

export function stripTelegramAsideDirectives(markdown: string): string {
  // Транспортные директивы не попадают в durable-проекцию: журнал хранит то, что прочитал человек.
  return authoredParts(markdown)
    .map((part) => takeTelegramKeepOpen(part).text)
    .join("\n\n");
}
