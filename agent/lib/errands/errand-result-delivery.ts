/** One Telegram request and one receipt, preserving the complete result and its sources. */
import { TELEGRAM_MESSAGE_TEXT_MAX_LENGTH } from "eve/channels/telegram";
import { deliverWorkspaceFile } from "../attachments/telegram-workspace-file-delivery.js";
import { relayChatMessage } from "../relay/chat-relay-transport.js";

export async function deliverErrandResult(input: { chatId: string; text: string }): Promise<string> {
  if (input.text.length <= TELEGRAM_MESSAGE_TEXT_MAX_LENGTH) return relayChatMessage(input);
  // The caller has already rechecked both identities and claimed its durable delivery ledger.
  // Reuse the existing file transport; do not split into untracked sends or shorten the result.
  const sent = await deliverWorkspaceFile({
    chatId: input.chatId,
    bytes: new TextEncoder().encode(input.text),
    caption: "Подборка по поручению участника семьи. Полный текст и источники — в файле. Ответ останется в вашем личном чате, пока вы явно не попросите передать его.",
    fileName: "Подборка.txt",
    mediaType: "text/plain; charset=utf-8",
    presentation: "document",
  });
  return sent.telegramMessageId;
}
