/**
 * Verified Telegram inbound actor classification tests.
 *
 * Constructs covered:
 * - Ordinary human senders remain Telegram user actors.
 * - Channel-authored supergroup posts use raw `sender_chat`, not Telegram's Channel_Bot identity.
 * - Another bot is a visible participant without identity, since Bot API 10.2 delivers its messages.
 * - Ambiguous, malformed, and anonymous-group senders fail closed.
 */
import { describe, expect, it } from "vitest";

import { telegramInboundActor } from "./telegram-inbound-actor.js";
import { groupMessage } from "./telegram-on-message.test-fixtures.js";

describe("telegramInboundActor", () => {
  it("projects an ordinary human sender", () => {
    expect(telegramInboundActor(groupMessage("Привет"))).toEqual({
      actorId: "telegram:telegram-101",
      displayName: "Анна",
      id: "telegram-101",
      kind: "telegram_user",
      timelineKind: "user",
      username: "anna",
    });
  });

  it("projects a verified channel sender instead of Channel_Bot", () => {
    expect(telegramInboundActor({
      ...groupMessage("@osinara_bot вопрос"),
      chat: { id: "-1001000000003", title: "Клуб разработчиков", type: "supergroup" },
      from: { firstName: "Channel", id: "136817688", isBot: true, username: "Channel_Bot" },
      raw: {
        date: 1_787_000_000,
        from: { first_name: "Channel", id: 136_817_688, is_bot: true, username: "Channel_Bot" },
        sender_chat: {
          id: -1_001_000_000_002,
          title: "Example Channel",
          type: "channel",
          username: "example_channel",
        },
      },
    })).toEqual({
      actorId: "telegram-channel:-1001000000002",
      displayName: "Example Channel",
      id: "-1001000000002",
      kind: "telegram_channel",
      timelineKind: "telegram_channel",
      username: "example_channel",
    });
  });

  it("projects another bot as a participant that carries no identity", () => {
    expect(telegramInboundActor({
      ...groupMessage("сводка погоды"),
      from: { firstName: "Погодный бот", id: "42", isBot: true, username: "weather_bot" },
      raw: {
        date: 1_787_000_000,
        from: { first_name: "Погодный бот", id: 42, is_bot: true, username: "weather_bot" },
      },
    })).toEqual({
      actorId: "telegram-bot:42",
      displayName: "Погодный бот",
      id: "42",
      kind: "telegram_bot",
      timelineKind: "telegram_bot",
      username: "weather_bot",
    });
  });

  it.each([
    {
      label: "anonymous supergroup sender",
      message: {
        ...groupMessage("anonymous"),
        from: { firstName: "Group", id: "1087968824", isBot: true },
        raw: {
          date: 1_787_000_000,
          from: { first_name: "Group", id: 1_087_968_824, is_bot: true },
          sender_chat: { id: -1_001_000_000_003, title: "Group", type: "supergroup" },
        },
      },
    },
    {
      label: "mismatched Channel_Bot identity",
      message: {
        ...groupMessage("mismatch"),
        from: { firstName: "Channel", id: "136817688", isBot: true },
        raw: {
          date: 1_787_000_000,
          from: { first_name: "Channel", id: 999, is_bot: true },
          sender_chat: { id: -1_001_000_000_002, title: "Example Channel", type: "channel" },
        },
      },
    },
    {
      label: "ordinary bot with channel-shaped sender_chat",
      message: {
        ...groupMessage("forged channel shape"),
        from: { firstName: "Bot", id: "42", isBot: true, username: "ordinary_bot" },
        raw: {
          date: 1_787_000_000,
          from: { first_name: "Bot", id: 42, is_bot: true, username: "ordinary_bot" },
          sender_chat: { id: -1_001_000_000_002, title: "Example Channel", type: "channel" },
        },
      },
    },
    {
      label: "human sender with conflicting sender_chat",
      message: {
        ...groupMessage("ambiguous"),
        raw: {
          date: 1_787_000_000,
          sender_chat: { id: -1_001_000_000_002, title: "Example Channel", type: "channel" },
        },
      },
    },
  ])("rejects $label", ({ message }) => {
    expect(telegramInboundActor(message)).toBeNull();
  });
});
