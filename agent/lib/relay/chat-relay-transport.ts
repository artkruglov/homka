/**
 * Отправка переданного сообщения в Telegram.
 *
 * Экспорт:
 * - `relayChatMessage`: один вызов Telegram без повторов и с проверкой подтверждённого id.
 *
 * У Telegram нет ключа идемпотентности, поэтому заявка пишется до этого вызова: второй раз то же
 * сообщение не уходит даже после сбоя связи.
 */
import { sendTelegramMessage } from "eve/channels/telegram";

import { TELEGRAM_API_REQUEST_TIMEOUT_MS } from "../../config.js";
import { AppError } from "../app-error.js";

export async function relayChatMessage(input: { chatId: string; text: string }): Promise<string> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    throw new AppError("AGENT_TELEGRAM_CONFIG_MISSING", "Не задан токен Telegram для передачи сообщения");
  }
  const signal = AbortSignal.timeout(TELEGRAM_API_REQUEST_TIMEOUT_MS);
  const sent = await sendTelegramMessage({
    body: { text: input.text },
    chatId: input.chatId,
    credentials: { botToken },
    fetch: (request, init) => fetch(request, { ...init, signal }),
  });
  if (!/^[1-9]\d*$/u.test(sent.id)) {
    throw new AppError(
      "AGENT_RELAY_DELIVERY_AMBIGUOUS",
      "Telegram принял сообщение, но не подтвердил его идентификатор",
    );
  }
  return sent.id;
}
