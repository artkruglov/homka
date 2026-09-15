/**
 * Capability-scoped Telegram timeline attachment references.
 *
 * Exports:
 * - `TelegramAttachmentReferenceAccess`: the exact media classes visible to the model.
 * - `visibleTelegramTimelineEntry`: removes unauthorized attachment metadata from one entry.
 */
import { isReadableTextDocumentCandidate } from "./attachments/attachment-policy.js";
import { isTelegramImageDocumentCandidate } from "./attachments/telegram-vision-attachment.js";
import type { TelegramGroupJournalEntry } from "./telegram-group-journal-context.js";

export type TelegramAttachmentReferenceAccess = "all" | "none" | {
  images: boolean;
  readableText: boolean;
};

export function visibleTelegramTimelineEntry(
  entry: TelegramGroupJournalEntry,
  access: TelegramAttachmentReferenceAccess,
): TelegramGroupJournalEntry {
  if (!entry.attachment || access === "all") return entry;
  if (access !== "none") {
    const imageAllowed = access.images && (
      entry.attachment.kind === "photo" || isTelegramImageDocumentCandidate(entry.attachment)
    );
    const textAllowed = access.readableText &&
      isReadableTextDocumentCandidate(entry.attachment);
    if (imageAllowed || textAllowed) return entry;
  }

  // Keep message history available while withholding every field of the unauthorized reference.
  const { attachment: _attachment, ...withoutAttachment } = entry;
  return withoutAttachment;
}
