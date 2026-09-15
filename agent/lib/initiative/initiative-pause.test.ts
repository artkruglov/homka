/**
 * Пауза после молчания снимается словом человека.
 *
 * Проверяется: личный ход отмечает начатые ботом разговоры отвеченными; групповой — нет, потому
 * что там человек отвечает чату, а не боту, и молчание в личке остаётся молчанием.
 */
import { describe, expect, it } from "vitest";

import { createTelegramMessageHandler } from "../telegram-on-message.js";
import {
  groupMessage,
  privateMessage,
  repositories,
  telegramContext,
} from "../telegram-on-message.test-fixtures.js";

describe("initiative pause", () => {
  it("clears the pause when the person writes in their own chat", async () => {
    const repository = repositories();
    repository.telegram.findIdentity.mockResolvedValue({
      familyId: "family-1", role: "owner", userId: "user-1",
    });
    repository.telegram.hasOwner.mockResolvedValue(true);
    const telegram = telegramContext();

    await createTelegramMessageHandler(repository)(telegram.context, privateMessage("Привет"));

    expect(repository.initiative.markAnswered).toHaveBeenCalledWith("user-1", expect.any(Date));
  });

  it("leaves the pause alone when the person speaks in a shared chat", async () => {
    const repository = repositories();
    repository.telegram.findIdentity.mockResolvedValue({
      familyId: "family-1", role: "owner", userId: "user-1",
    });
    repository.telegram.hasOwner.mockResolvedValue(true);
    const telegram = telegramContext();

    await createTelegramMessageHandler(repository)(
      telegram.context, groupMessage("Мия, привет"),
    );

    expect(repository.initiative.markAnswered).not.toHaveBeenCalled();
  });
});
