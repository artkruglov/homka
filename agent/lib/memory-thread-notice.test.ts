/**
 * Telegram memory-thread creation notice delivery tests.
 *
 * Constructs covered:
 * - A committed background thread notice appears on the next authorized turn exactly as stored.
 * - Family and external group turns never inspect or send thread creation notices.
 * - The notice is informational Russian text and never asks for confirmation.
 */
import { describe, expect, it } from "vitest";

import { createTelegramMessageHandler } from "./telegram-on-message.js";
import {
  BOT_USERNAME,
  groupMessage,
  privateMessage,
  repositories,
  telegramContext,
} from "./telegram-on-message.test-fixtures.js";

describe("memory thread creation notice", () => {
  it("shows the pending title and purpose on the next authorized turn", async () => {
    const repository = repositories();
    repository.telegram.findIdentity.mockResolvedValue({
      familyId: "family-1",
      role: "owner",
      userId: "user-1",
    });
    repository.telegram.hasOwner.mockResolvedValue(true);
    repository.threadNotices.takePending.mockResolvedValueOnce({
      deliveryToken: "00000000-0000-4000-8000-000000000002",
      purpose: "Сохранять цели, решения и результаты тренировок.",
      text: "Начата новая нить памяти: «Тренировки». Сохранять цели, решения и результаты тренировок.",
      threadId: "00000000-0000-4000-8000-000000000001",
      threadRef: "thread_0123456789abcdef0123456789abcdef",
      title: "Тренировки",
    }).mockResolvedValueOnce(null);
    const telegram = telegramContext();
    const handler = createTelegramMessageHandler(repository);

    await handler(telegram.context, privateMessage("Продолжим"));
    await handler(telegram.context, { ...privateMessage("Ещё вопрос"), messageId: "2" });

    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect(telegram.sendMessage).toHaveBeenCalledWith(expect.stringContaining(
      "Начата новая нить памяти: «Тренировки». Сохранять цели, решения и результаты тренировок.",
    ));
    expect(telegram.sendMessage.mock.calls[0]![0]).not.toMatch(/подтверд/iu);
    expect(repository.threadNotices.complete).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
      expect.any(String),
    );
  });

  it.each([
    { groupType: "family_private" as const, telegramChatType: "group" as const },
    { groupType: "family_private" as const, telegramChatType: "supergroup" as const },
    { groupType: "external" as const, telegramChatType: "group" as const },
    { groupType: "external" as const, telegramChatType: "supergroup" as const },
  ])(
    "does not inspect pending notices in a $groupType Telegram $telegramChatType turn",
    async ({ groupType, telegramChatType }) => {
      const repository = repositories();
      repository.telegram.findGroup.mockResolvedValue({
        familyId: "family-1",
        groupId: "group-1",
        messageMode: "addressed_only",
        telegramChatId: "group-101",
        toolAllowlist: [],
        type: groupType,
      });
      repository.telegram.findIdentity.mockResolvedValue({
        familyId: "family-1",
        role: "member",
        userId: "user-1",
      });
      repository.threadNotices.takePending.mockResolvedValue({
        deliveryToken: "00000000-0000-4000-8000-000000000002",
        purpose: "Скрытое системное уведомление.",
        text: "Начата новая нить памяти: «Скрытая».",
        threadId: "00000000-0000-4000-8000-000000000001",
        threadRef: "thread_0123456789abcdef0123456789abcdef",
        title: "Скрытая",
      });
      const telegram = telegramContext();
      const handler = createTelegramMessageHandler(repository);
      const message = groupMessage(`@${BOT_USERNAME} продолжим`);

      await handler(telegram.context, {
        ...message,
        chat: { ...message.chat, type: telegramChatType },
      });

      expect(repository.threadNotices.takePending).not.toHaveBeenCalled();
      expect(repository.threadNotices.complete).not.toHaveBeenCalled();
      expect(telegram.sendMessage).not.toHaveBeenCalled();
    },
  );
});
