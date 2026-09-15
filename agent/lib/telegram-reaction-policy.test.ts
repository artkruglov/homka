/**
 * Telegram reaction policy parsing tests.
 *
 * Constructs covered:
 * - An omitted `available_reactions` documents that every emoji reaction is allowed.
 * - An explicit list keeps only the emoji reactions a bot can actually send.
 * - An empty list is a chat with reactions turned off, not an unknown policy.
 */
import { describe, expect, it } from "vitest";

import { telegramReactionPolicyEmoji } from "./telegram-reaction-policy.js";

describe("telegramReactionPolicyEmoji", () => {
  it("treats an omitted field as every emoji reaction allowed", () => {
    expect(telegramReactionPolicyEmoji({ id: -1001, type: "supergroup" }))
      .toEqual({ allowsAll: true, emoji: [] });
  });

  it("keeps the explicit emoji list of the chat", () => {
    const result = {
      available_reactions: [
        { emoji: "👍", type: "emoji" },
        { emoji: "❤️", type: "emoji" },
      ],
    };

    expect(telegramReactionPolicyEmoji(result))
      .toEqual({ allowsAll: false, emoji: ["👍", "❤️"] });
  });

  it("drops reaction kinds a bot cannot send", () => {
    const result = {
      available_reactions: [
        { custom_emoji_id: "5789", type: "custom_emoji" },
        { type: "paid" },
        { emoji: "🔥", type: "emoji" },
      ],
    };

    expect(telegramReactionPolicyEmoji(result)).toEqual({ allowsAll: false, emoji: ["🔥"] });
  });

  it("reports a chat with reactions turned off", () => {
    expect(telegramReactionPolicyEmoji({ available_reactions: [] }))
      .toEqual({ allowsAll: false, emoji: [] });
  });

  it("refuses a malformed provider answer instead of assuming a policy", () => {
    expect(() => telegramReactionPolicyEmoji({ available_reactions: "👍" }))
      .toThrow("AGENT_TELEGRAM_REACTION_POLICY_INVALID");
  });
});
