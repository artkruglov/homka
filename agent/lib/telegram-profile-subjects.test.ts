/**
 * Verified Telegram profile-subject signal tests.
 *
 * Constructs covered:
 * - Reply senders and text_mention user objects yield exact Telegram IDs.
 * - Username mentions, display names, bots, and malformed raw entities never become subjects.
 */
import { describe, expect, it } from "vitest";

import { privateMessage } from "./telegram-on-message.test-fixtures.js";
import { verifiedTelegramProfileSignals } from "./telegram-profile-subjects.js";

describe("verified Telegram profile signals", () => {
  it("uses only exact reply and text_mention user identities", () => {
    const message = {
      ...privateMessage("Анна и @petr"),
      raw: {
        entities: [
          { type: "mention", offset: 7, length: 5 },
          { type: "text_mention", offset: 0, length: 4, user: { id: 201, is_bot: false } },
          { type: "text_mention", offset: 0, length: 4, user: { id: "201", is_bot: false } },
          { type: "text_mention", offset: 0, length: 4, user: { id: 202, is_bot: true } },
        ],
      },
      replyToMessage: {
        chat: { id: "telegram-101", type: "private" as const },
        from: { id: "203", isBot: false },
        messageId: "10",
      },
    };

    expect(verifiedTelegramProfileSignals(message)).toEqual({
      explicitMentionTelegramUserIds: ["201"],
      replyTelegramUserId: "203",
    });
  });

  it("does not infer identities from unverified names or usernames", () => {
    const message = {
      ...privateMessage("Анна сказала, что Пётр любит улун"),
      raw: { entities: [{ type: "mention", offset: 0, length: 5 }] },
    };

    expect(verifiedTelegramProfileSignals(message)).toEqual({
      explicitMentionTelegramUserIds: [],
      replyTelegramUserId: null,
    });
  });
});
