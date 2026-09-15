/**
 * Telegram reaction delivery tests.
 *
 * Constructs covered:
 * - `setTelegramMessageReaction`: exact current-message Bot API request.
 * - Provider rejection and malformed acknowledgements fail with stable application errors.
 */
import type { TelegramHandle } from "eve/channels/telegram";
import { describe, expect, it, vi } from "vitest";

import {
  TELEGRAM_REACTION_EMOJI,
  nearestTelegramReactionEmoji,
  normalizeTelegramReactionEmoji,
  setTelegramMessageReaction,
} from "./telegram-message-reaction.js";

function telegramHandle(response: unknown, ok = true) {
  const request = vi.fn().mockResolvedValue({ body: response, ok, status: ok ? 200 : 400 });
  return {
    request,
    telegram: {
      chatId: "-100123",
      request,
    } as unknown as TelegramHandle,
  };
}

describe("normalizeTelegramReactionEmoji", () => {
  it("lists the documented Bot API reaction set without variation selectors", () => {
    expect(TELEGRAM_REACTION_EMOJI).toHaveLength(73);
    expect(TELEGRAM_REACTION_EMOJI).toContain("❤");
    expect(TELEGRAM_REACTION_EMOJI).toContain("🤷‍♀");
    for (const emoji of TELEGRAM_REACTION_EMOJI) expect(emoji).not.toContain("\uFE0F");
  });

  it.each([
    ["❤️", "❤"],
    ["❤", "❤"],
    ["🤷‍♀️", "🤷‍♀"],
    ["👍", "👍"],
    ["🫡", "🫡"],
  ])("maps %s to the canonical reaction %s", (input, expected) => {
    expect(normalizeTelegramReactionEmoji(input)).toBe(expected);
  });

  // Telegram answers 400 REACTION_INVALID to any emoji outside its set (9 сентября 2026: a cat
  // reaction to «молодец, хорошая кошка» never reached the chat).
  it.each(["😸", "🐱", "1️⃣", "🇺🇸", "не emoji", "", "🔥🔥"])("rejects %s", (input) => {
    expect(normalizeTelegramReactionEmoji(input)).toBeNull();
  });
});

describe("nearestTelegramReactionEmoji", () => {
  it("keeps an allowed reaction as itself", () => {
    expect(nearestTelegramReactionEmoji("🔥")).toBe("🔥");
    expect(nearestTelegramReactionEmoji("❤️")).toBe("❤");
  });

  // The person asked for an emotion, so the gesture becomes the closest reaction Telegram takes,
  // never a text message (owner's decision, 9 сентября 2026).
  it.each([
    ["😸", "🥰"],
    ["🐱", "🥰"],
    ["😂", "🤣"],
    ["😊", "😁"],
    ["💕", "❤"],
    ["🧡", "❤"],
    ["😔", "😢"],
    ["🥳", "🎉"],
    ["😠", "😡"],
    ["🧐", "🤔"],
    ["😳", "😱"],
    ["🙌", "👏"],
    ["😏", "😎"],
    ["1️⃣", "👍"],
    ["🇺🇸", "👍"],
    ["🦖", "👍"],
  ])("maps %s to the closest allowed reaction %s", (input, expected) => {
    expect(nearestTelegramReactionEmoji(input)).toBe(expected);
    expect(TELEGRAM_REACTION_EMOJI).toContain(expected);
  });
});

describe("setTelegramMessageReaction", () => {
  it("sends the canonical form of an emoji written with a variation selector", async () => {
    const target = telegramHandle({ ok: true, result: true });

    await expect(setTelegramMessageReaction(target.telegram, "44", "❤️")).resolves.toBe("applied");
    expect(target.request).toHaveBeenCalledWith("setMessageReaction", expect.objectContaining({
      reaction: [{ emoji: "❤", type: "emoji" }],
    }));
  });

  it("logs the provider description and the emoji when the reaction is declined", async () => {
    const target = telegramHandle({ description: "Bad Request: REACTION_INVALID", ok: false }, false);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(setTelegramMessageReaction(target.telegram, "42", "👎")).resolves.toBe("unavailable");
      expect(log).toHaveBeenCalledWith(expect.stringContaining("REACTION_INVALID"));
      expect(log).toHaveBeenCalledWith(expect.stringContaining("👎"));
    } finally {
      log.mockRestore();
    }
  });

  it("sets one small allowlisted reaction on the verified current message", async () => {
    const target = telegramHandle({ ok: true, result: true });

    await expect(
      setTelegramMessageReaction(target.telegram, "42", "👌"),
    ).resolves.toBe("applied");
    expect(target.request).toHaveBeenCalledWith("setMessageReaction", {
      chat_id: "-100123",
      is_big: false,
      message_id: 42,
      reaction: [{ emoji: "👌", type: "emoji" }],
    });
  });

  it("delivers an expressive allowlisted reaction without changing the transport shape", async () => {
    const target = telegramHandle({ ok: true, result: true });

    await expect(
      setTelegramMessageReaction(target.telegram, "43", "🔥"),
    ).resolves.toBe("applied");
    expect(target.request).toHaveBeenCalledWith("setMessageReaction", {
      chat_id: "-100123",
      is_big: false,
      message_id: 43,
      reaction: [{ emoji: "🔥", type: "emoji" }],
    });
  });

  it("rejects an invalid inbound message id before calling Telegram", async () => {
    const target = telegramHandle({ ok: true, result: true });

    await expect(setTelegramMessageReaction(target.telegram, "message-42", "👍"))
      .rejects.toThrowError(/AGENT_TELEGRAM_REACTION_TARGET_INVALID/u);
    expect(target.request).not.toHaveBeenCalled();
  });

  it("keeps a provider-declined reaction silent and reports it as unavailable", async () => {
    const target = telegramHandle({ description: "reaction not allowed", ok: false }, false);

    await expect(setTelegramMessageReaction(target.telegram, "42", "👎"))
      .resolves.toBe("unavailable");
  });

  it.each([{ body: { ok: true, result: false }, ok: true }, { body: null, ok: true }])(
    "fails closed when Telegram returns a malformed acknowledgement",
    async ({ body, ok }) => {
      const target = telegramHandle(body, ok);

      await expect(setTelegramMessageReaction(target.telegram, "42", "👎"))
        .rejects.toThrowError(/AGENT_TELEGRAM_REACTION_DELIVERY_FAILED/u);
    },
  );

  it("adds the stable delivery code to a transport failure and rethrows it", async () => {
    const error = new TypeError("fetch failed");
    const request = vi.fn().mockRejectedValue(error);
    const telegram = { chatId: "-100123", request } as unknown as TelegramHandle;

    await expect(setTelegramMessageReaction(telegram, "42", "👍"))
      .rejects.toBe(error);
    expect(error.message).toContain("AGENT_TELEGRAM_REACTION_DELIVERY_FAILED");
  });
});
