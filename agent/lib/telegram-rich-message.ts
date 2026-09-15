/**
 * Plain text of a Bot API rich message.
 *
 * Exports:
 * - `richMessagePlainText`: flattens `rich_message.blocks` of a raw Telegram message into text.
 * - `withRichMessageText`: fills an inbound update's empty `text` from its rich blocks.
 *
 * Key constructs:
 * - Bot API 10.1 (June 2026) delivers rich messages in `message.rich_message`; `message.text` is
 *   absent or holds only a plain fallback. Eve 0.40.0 parses `text` and `caption` alone, so a
 *   collapsed "Полный ответ" from another bot arrived as an empty message. Block order is kept;
 *   a details block contributes its summary and its nested blocks; rich text given as parts
 *   (strings and link entities) is joined.
 */
import type { TelegramUpdate } from "eve/channels/telegram";

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

/**
 * RichText arrives as a string, as `{ text, entities }`, or as an array of parts: plain strings
 * mixed with typed entities such as `{ type: "url", text, url }`. Only the readable text matters,
 * so parts are joined in order; an array that was ignored here dropped every paragraph with a link.
 */
function richText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(richText).join("");
  const text = record(value)?.text;
  return typeof text === "string" || Array.isArray(text) ? richText(text) : "";
}

function blocksText(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((block) => blockText(record(block)));
}

function blockText(block: JsonRecord | null): string[] {
  if (!block) return [];
  switch (block.type) {
    case "paragraph":
    case "section_heading":
    case "preformatted":
    case "footer":
    case "thinking":
    case "mathematical_expression": {
      const text = richText(block.text);
      return text ? [text] : [];
    }
    case "details": {
      const summary = richText(block.summary ?? block.header);
      return [...(summary ? [summary] : []), ...blocksText(block.blocks)];
    }
    case "block_quotation":
    case "expandable_block_quotation":
      return blocksText(block.blocks);
    case "pull_quotation": {
      const text = richText(block.text);
      return [...(text ? [text] : []), ...blocksText(block.blocks)];
    }
    case "list":
      return Array.isArray(block.items)
        ? block.items.flatMap((item) => {
          const entry = record(item);
          const text = richText(entry?.text);
          return text ? [text] : blocksText(entry?.blocks);
        })
        : [];
    case "table":
      return Array.isArray(block.rows)
        ? block.rows.flatMap((row) => {
          const cells = record(row)?.cells;
          return Array.isArray(cells)
            ? [cells.map((cell) => richText(record(cell)?.text ?? cell)).filter(Boolean).join(" | ")]
            : [];
        }).filter(Boolean)
        : [];
    case "animation":
    case "audio":
    case "photo":
    case "video":
    case "voice_note":
    case "document": {
      const caption = richText(record(block.caption)?.text ?? block.caption);
      return caption ? [caption] : [];
    }
    default:
      return [];
  }
}

export function richMessagePlainText(raw: JsonRecord): string | null {
  const rich = record(raw.rich_message);
  if (!rich) return null;
  const fromBlocks = blocksText(rich.blocks).map((part) => part.trim()).filter(Boolean).join("\n\n");
  if (fromBlocks) return fromBlocks;
  return typeof rich.text === "string" && rich.text.trim() ? rich.text.trim() : null;
}

export function withRichMessageText(update: TelegramUpdate): TelegramUpdate {
  if (update.kind !== "message" || update.message.text.trim()) return update;
  const text = richMessagePlainText(update.message.raw);
  return text === null ? update : { ...update, message: { ...update.message, text } };
}
