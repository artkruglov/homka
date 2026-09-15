/**
 * Normalize a top-level Telegram migration service message without granting any authority.
 * Callers must obtain raw input from verified durable ingress, never from a model/tool argument.
 * Export: parseGroupMigrationServiceMessage, returning one old/new chat pair or null.
 */
import { AppError } from "../app-error.js";

export interface GroupMigrationServiceMessage {
  readonly updateId: string;
  readonly oldChatId: string;
  readonly newChatId: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function chatId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value < 0;
}

export function parseGroupMigrationServiceMessage(raw: unknown): GroupMigrationServiceMessage | null {
  const update = record(raw);
  const message = record(update?.message);
  if (!message) return null;
  const to = Object.hasOwn(message, "migrate_to_chat_id");
  const from = Object.hasOwn(message, "migrate_from_chat_id");
  if (!to && !from) return null;
  const chat = record(message.chat);
  const oldId = to ? chat?.id : message.migrate_from_chat_id;
  const newId = to ? message.migrate_to_chat_id : chat?.id;
  const updateId = update?.update_id;
  if (to === from || !chatId(oldId) || !chatId(newId) || oldId === newId ||
      chat?.type !== (to ? "group" : "supergroup") ||
      typeof updateId !== "number" || !Number.isSafeInteger(updateId) || updateId < 0) {
    throw new AppError("AGENT_TELEGRAM_GROUP_MIGRATION_INVALID",
      "Telegram передал некорректные сведения о переносе группы");
  }
  return { updateId: String(updateId), oldChatId: String(oldId), newChatId: String(newId) };
}
