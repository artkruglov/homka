/**
 * Lazy Telegram attachment materialization tests.
 *
 * Constructs covered:
 * - `createTelegramAttachmentMaterializer`: resolves an authorized reference and persists bytes only on demand.
 */
import { describe, expect, it, vi } from "vitest";

import { createTelegramAttachmentMaterializer } from "./telegram-attachment-materializer.js";

const auth = {
  familyId: "00000000-0000-4000-8000-000000000001",
  groupId: "00000000-0000-4000-8000-000000000002",
  groupType: "family_private" as const,
  role: "member" as const,
  telegramChatType: "group" as const,
  userId: "00000000-0000-4000-8000-000000000003",
};

describe("createTelegramAttachmentMaterializer", () => {
  it("materializes the authorized Telegram reference into the family workspace", async () => {
    const reference = {
      attachment: {
        fileId: "telegram-file-secret",
        fileName: "договор.pdf",
        fileUniqueId: "stable-file-id",
        kind: "document" as const,
        mediaType: "application/pdf",
        size: 1_024,
      },
      chatId: "-1001",
      messageId: "42",
    };
    const findAttachment = vi.fn().mockResolvedValue(reference);
    const persist = vi.fn().mockResolvedValue([{
      mediaType: "application/pdf",
      path: "inbox/groups/00000000-0000-4000-8000-000000000002/42/договор.pdf",
      scope: "family",
      telegramMessageId: "42",
    }]);
    const materialize = createTelegramAttachmentMaterializer({ findAttachment, persist });

    await expect(materialize(auth, "00000000-0000-4000-8000-000000000099")).resolves.toEqual({
      mediaType: "application/pdf",
      path: "inbox/groups/00000000-0000-4000-8000-000000000002/42/договор.pdf",
      scope: "family",
      telegramMessageId: "42",
    });
    expect(findAttachment).toHaveBeenCalledWith(auth, "00000000-0000-4000-8000-000000000099");
    expect(persist).toHaveBeenCalledWith({
      attachments: [reference.attachment],
      auth,
      chatId: "-1001",
      messageId: "42",
      scope: "family",
    });
  });

  it("materializes an authorized external text reference into the group workspace", async () => {
    const externalAuth = {
      ...auth,
      groupType: "external" as const,
      role: "external" as const,
      telegramChatType: "supergroup" as const,
      userId: null,
    };
    const reference = {
      attachment: {
        fileId: "telegram-text-secret",
        fileName: "notes.md",
        fileUniqueId: "stable-text-id",
        kind: "document" as const,
        mediaType: "text/markdown",
        size: 256,
      },
      chatId: "-1002",
      messageId: "43",
    };
    const findAttachment = vi.fn().mockResolvedValue(reference);
    const persist = vi.fn().mockResolvedValue([{
      mediaType: "text/markdown",
      path: "inbox/43/notes.md",
      scope: "group",
      telegramMessageId: "43",
    }]);
    const materialize = createTelegramAttachmentMaterializer({ findAttachment, persist });

    await expect(materialize(
      externalAuth,
      "00000000-0000-4000-8000-000000000098",
    )).resolves.toMatchObject({ path: "inbox/43/notes.md", scope: "group" });
    expect(persist).toHaveBeenCalledWith(expect.objectContaining({
      auth: externalAuth,
      scope: "group",
    }));
  });
});
