/**
 * Message series tests.
 *
 * Constructs covered:
 * - Only plain text messages with a personal sender may form a series.
 * - Replies and mentions aimed at someone else, commands, media, voice, and forwards stay alone.
 * - A series continues only for the same author in the same chat and topic.
 * - The series marker survives the raw-message transport and rejects malformed shapes.
 */
import { parseTelegramUpdate } from "eve/channels/telegram";
import { describe, expect, it } from "vitest";

import {
  continuesSeries,
  isSeriesEligible,
  readTelegramSeriesMarker,
  withSeriesMarker,
} from "./telegram-message-series.js";

const BOT = "family_agent";

function update(message: Record<string, unknown>, updateId = 1) {
  const parsed = parseTelegramUpdate({
    message: {
      chat: { id: -100, title: "Группа", type: "supergroup" },
      date: 1_700_000_000,
      from: { first_name: "Анна", id: 101, is_bot: false, username: "anna" },
      message_id: updateId,
      text: "обычный текст",
      ...message,
    },
    update_id: updateId,
  });
  if (!parsed) throw new Error("AGENT_TEST_TELEGRAM_UPDATE_INVALID: Не создано тестовое обновление");
  return parsed;
}

describe("isSeriesEligible", () => {
  it("accepts a plain text message from a person or another bot", () => {
    expect(isSeriesEligible(update({}), BOT)).toBe(true);
    expect(isSeriesEligible(update({ from: { first_name: "Osinara", id: 7, is_bot: true, username: "osinara_bot" } }), BOT)).toBe(true);
    expect(isSeriesEligible(update({ chat: { id: 101, type: "private" } }), BOT)).toBe(true);
  });

  it("accepts a reply to this bot and a mention of this bot only", () => {
    expect(isSeriesEligible(update({
      reply_to_message: { chat: { id: -100, type: "supergroup" }, date: 1, from: { first_name: "Мия", id: 9, is_bot: true, username: BOT }, message_id: 5, text: "ответ" },
    }), BOT)).toBe(true);
    expect(isSeriesEligible(update({ text: `@${BOT} привет` }), BOT)).toBe(true);
  });

  it.each([
    ["reply to someone else", { reply_to_message: { chat: { id: -100, type: "supergroup" }, date: 1, from: { first_name: "Боря", id: 102, is_bot: false }, message_id: 5, text: "х" } }],
    ["mention of someone else", { text: "@osinara_bot привет" }],
    ["slash command", { text: "/start" }],
    ["voice", { text: "", voice: { file_id: "v", file_size: 1, mime_type: "audio/ogg" } }],
    ["photo", { photo: [{ file_id: "p", file_unique_id: "u", height: 1, width: 1 }] }],
    ["forward", { forward_origin: { date: 1, sender_user: { first_name: "Х", id: 3, is_bot: false }, type: "user" } }],
    ["channel post", { from: { first_name: "Channel", id: 136817688, is_bot: true, username: "Channel_Bot" }, sender_chat: { id: -1001, title: "Канал", type: "channel" } }],
    ["empty text", { text: "   " }],
  ])("keeps %s out of a series", (_name, overrides) => {
    expect(isSeriesEligible(update(overrides), BOT)).toBe(false);
  });
});

describe("continuesSeries", () => {
  it("continues for the same author in the same chat and topic", () => {
    expect(continuesSeries(update({}, 1), update({ text: "и ещё" }, 2), BOT)).toBe(true);
    expect(continuesSeries(
      update({ is_topic_message: true, message_thread_id: 7 }, 1),
      update({ is_topic_message: true, message_thread_id: 7, text: "и ещё" }, 2),
      BOT,
    )).toBe(true);
  });

  it.each([
    ["another author", { from: { first_name: "Боря", id: 102, is_bot: false } }],
    ["another chat", { chat: { id: -200, title: "Другая", type: "supergroup" } }],
    ["another topic", { is_topic_message: true, message_thread_id: 8 }],
    ["an ineligible message", { text: "/help" }],
  ])("stops at %s", (_name, overrides) => {
    expect(continuesSeries(update({}, 1), update(overrides, 2), BOT)).toBe(false);
  });
});

describe("series marker", () => {
  it("travels inside the raw message and reads back exactly", () => {
    const current = withSeriesMarker(update({}) as never, {
      addressed: true,
      role: "current",
      telegramMessageIds: ["1", "2"],
    });
    expect(current.kind).toBe("message");
    if (current.kind !== "message") return;
    expect(current.message.text).toBe("обычный текст");
    expect(readTelegramSeriesMarker(current.message.raw)).toEqual({
      addressed: true,
      role: "current",
      telegramMessageIds: ["1", "2"],
    });
    const context = withSeriesMarker(update({}) as never, { role: "context" });
    if (context.kind !== "message") return;
    expect(readTelegramSeriesMarker(context.message.raw)).toEqual({ role: "context" });
  });

  it("ignores an absent or malformed marker", () => {
    expect(readTelegramSeriesMarker({})).toBeNull();
    expect(readTelegramSeriesMarker({ osinara_series: "current" })).toBeNull();
    expect(readTelegramSeriesMarker({ osinara_series: { role: "current" } })).toBeNull();
    expect(readTelegramSeriesMarker({
      osinara_series: { addressed: true, role: "current", telegramMessageIds: ["x"] },
    })).toBeNull();
  });
});
