/**
 * Installer Telegram validation boundary.
 *
 * Exports:
 * - `validateTelegramBot`: validates a Bot API token through getMe and returns trusted identity.
 */
import type { GetTelegramMe } from "./contracts.ts";
import { InstallerError } from "./errors.ts";

const TELEGRAM_BOT_TOKEN_PATTERN = /^(?<id>[1-9][0-9]*):[A-Za-z0-9_-]+$/u;
const TELEGRAM_USERNAME_PATTERN = /^[A-Za-z0-9_]{5,32}$/u;

export async function validateTelegramBot(
  token: string,
  getMe: GetTelegramMe,
): Promise<{ id: number; username: string }> {
  const normalizedToken = token.trim();
  const match = TELEGRAM_BOT_TOKEN_PATTERN.exec(normalizedToken);
  if (!match?.groups?.id) {
    throw new InstallerError(
      "OSINARA_INSTALL_TELEGRAM_TOKEN_INVALID",
      "Токен Telegram-бота имеет некорректный формат. Получите новый токен у BotFather",
    );
  }

  let response: Awaited<ReturnType<GetTelegramMe>>;
  try {
    response = await getMe(normalizedToken);
  } catch (error) {
    throw new InstallerError(
      "OSINARA_INSTALL_TELEGRAM_VALIDATION_FAILED",
      "Не удалось проверить Telegram-бота через getMe. Проверьте сеть и повторите установку",
      { cause: error },
    );
  }
  if (!response.ok) {
    throw new InstallerError(
      "OSINARA_INSTALL_TELEGRAM_VALIDATION_FAILED",
      "Telegram отклонил токен бота. Получите актуальный токен у BotFather",
    );
  }

  const expectedId = Number(match.groups.id);
  const { id, is_bot: isBot, username } = response.result;
  if (
    !Number.isSafeInteger(id) ||
    id !== expectedId ||
    !isBot ||
    typeof username !== "string" ||
    !TELEGRAM_USERNAME_PATTERN.test(username)
  ) {
    throw new InstallerError(
      "OSINARA_INSTALL_TELEGRAM_IDENTITY_INVALID",
      "Ответ Telegram не содержит ожидаемую подтвержденную identity бота",
    );
  }
  return { id, username };
}
