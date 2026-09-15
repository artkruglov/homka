/** Read a group photo through the existing live-authorized Telegram attachment boundary. */
import { AppError } from "../app-error.js";
import { downloadTelegramAttachment } from "../attachments/telegram-attachment-download.js";
import { telegramGroupAttachmentRepository } from "../attachments/telegram-group-attachment-repository.js";
import type { WorkspaceAuthorization } from "../workspaces/workspace-repository.js";

export function createImageReferenceAttachmentReader(dependencies: {
  find: typeof telegramGroupAttachmentRepository.find;
  download: typeof downloadTelegramAttachment;
}) {
  return async (auth: WorkspaceAuthorization, attachmentId: string): Promise<Buffer> => {
    const reference = await dependencies.find(auth, attachmentId);
    if (reference.attachment.size !== undefined && reference.attachment.size > 8 * 1024 * 1024) {
      throw new AppError("AGENT_IMAGE_REFERENCE_INVALID", "Для редактирования нужна фотография размером до 8 МБ");
    }
    return dependencies.download(reference.attachment);
  };
}

export const readImageReferenceAttachment = createImageReferenceAttachmentReader({
  find: telegramGroupAttachmentRepository.find,
  download: downloadTelegramAttachment,
});
