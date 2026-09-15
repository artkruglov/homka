/**
 * Canonical Telegram group continuation-token identity.
 *
 * Export:
 * - `groupCanonicalContinuationToken`: derives an opaque stable token from group ID and verified topic.
 */
import { AppError } from "../app-error.js";

const GROUP_TOKEN_PREFIX = "osinara:group";

export function groupCanonicalContinuationToken(
  groupId: string,
  telegramForumTopicId: number | null,
): string {
  // Group IDs come from PostgreSQL; topic IDs must still be checked at this application boundary.
  if (!groupId) {
    throw new AppError(
      "AGENT_GROUP_SESSION_ID_INVALID",
      "Не удалось определить зарегистрированную Telegram-группу",
    );
  }
  if (
    telegramForumTopicId !== null &&
    (!Number.isSafeInteger(telegramForumTopicId) || telegramForumTopicId <= 0)
  ) {
    throw new AppError(
      "AGENT_TELEGRAM_TOPIC_INVALID",
      "Telegram передал некорректный идентификатор темы",
    );
  }
  const topic = telegramForumTopicId === null ? "main" : `topic:${telegramForumTopicId}`;
  return `${GROUP_TOKEN_PREFIX}:${groupId}:${topic}`;
}
