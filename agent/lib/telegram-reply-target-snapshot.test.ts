/**
 * Verified Telegram reply-target snapshot tests.
 *
 * Constructs covered:
 * - `telegramReplyTargetSnapshot`: extracts an unavailable target and partial quote from raw input.
 */
import type { TelegramMessage } from "eve/channels/telegram";
import { describe, expect, it } from "vitest";

import { telegramReplyTargetSnapshot } from "./telegram-reply-target-snapshot.js";

function productionReply(): TelegramMessage {
  return {
    attachments: [],
    caption: "",
    chat: { id: "-1001000000003", title: "Чат стартапов", type: "supergroup" },
    from: { firstName: "Пух", id: "136817688", isBot: false },
    messageId: "51002",
    raw: {
      date: 1_786_542_434,
      quote: { text: "streisand" },
      reply_to_message: {
        chat: { id: -1_001_000_000_003, title: "Чат стартапов", type: "supergroup" },
        date: 1_786_542_306,
        from: { first_name: "Channel", id: 136_817_688, is_bot: true, username: "Channel_Bot" },
        message_id: 51_001,
        sender_chat: { id: -1_001_823_620_813, title: "nlp_daily", type: "channel", username: "nlp_daily" },
        text: "У меня настроен vless, ссылочку кинул в streisand, и орка работает на телефоне",
      },
    },
    replyToMessage: {
      chat: { id: "-1001000000003", title: "Чат стартапов", type: "supergroup" },
      from: { firstName: "Channel", id: "136817688", isBot: true, username: "Channel_Bot" },
      messageId: "51001",
    },
    text: "@osinara_bot а чо это",
  };
}

describe("telegramReplyTargetSnapshot", () => {
  it("extracts the full unavailable target, selected quote, and channel author", () => {
    expect(telegramReplyTargetSnapshot(productionReply())).toEqual({
      contentText: "У меня настроен vless, ссылочку кинул в streisand, и орка работает на телефоне",
      quotedText: "streisand",
      senderDisplayName: "nlp_daily",
      senderUsername: "nlp_daily",
    });
  });

  it("rejects a raw target that does not match the parsed reply identity", () => {
    const message = productionReply();
    const raw = message.raw.reply_to_message as Record<string, unknown>;

    expect(telegramReplyTargetSnapshot({
      ...message,
      raw: { ...message.raw, reply_to_message: { ...raw, message_id: 51_000 } },
    })).toBeNull();
  });
});
