import { describe, expect, it } from "vitest";
import { parseGroupMigrationServiceMessage } from "./service-message.js";

const oldId = -1000000006;
const newId = -1001000000004;
const message = (chat: number, type: string, fields: Record<string, unknown>) => ({
  update_id: 527096408,
  message: { message_id: 20, chat: { id: chat, type }, ...fields },
});

describe("verified group migration service message shape", () => {
  it.each([
    message(oldId, "group", { migrate_to_chat_id: newId }),
    message(newId, "supergroup", { migrate_from_chat_id: oldId }),
  ])("normalizes either Telegram service message without a 32-bit truncation", (raw) => {
    expect(parseGroupMigrationServiceMessage(raw)).toEqual({
      updateId: "527096408", oldChatId: String(oldId), newChatId: String(newId),
    });
  });

  it.each([
    { update_id: 1, message: { text: "migrate_to_chat_id=-1001000000004" } },
    { update_id: 1, message: { reply_to_message: { migrate_to_chat_id: newId } } },
    { update_id: 1, edited_message: { chat: { id: oldId, type: "group" }, migrate_to_chat_id: newId } },
    { update_id: 1, callback_query: { data: JSON.stringify({ migrate_to_chat_id: newId }) } },
  ])("does not treat text, quoted or edited content as a service event", (raw) => {
    expect(parseGroupMigrationServiceMessage(raw)).toBeNull();
  });

  it.each([
    message(oldId, "private", { migrate_to_chat_id: newId }),
    message(newId, "group", { migrate_from_chat_id: oldId }),
    message(oldId, "group", { migrate_to_chat_id: oldId }),
    message(oldId, "group", { migrate_to_chat_id: 123 }),
    message(oldId, "group", { migrate_to_chat_id: -Number.MAX_SAFE_INTEGER - 1 }),
    message(oldId, "group", { migrate_to_chat_id: String(newId) }),
    message(oldId, "group", { migrate_to_chat_id: newId, migrate_from_chat_id: -5 }),
    { ...message(oldId, "group", { migrate_to_chat_id: newId }), update_id: -1 },
  ])("rejects malformed service events instead of authorizing a guessed mapping", (raw) => {
    expect(() => parseGroupMigrationServiceMessage(raw)).toThrow(/AGENT_TELEGRAM_GROUP_MIGRATION_INVALID/);
  });
});
