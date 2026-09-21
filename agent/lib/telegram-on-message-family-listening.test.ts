/**
 * Family group listening (T03 in docs/task-user-stories.ru.md).
 *
 * «Надо заказать фильтры, кто возьмёт?» в семейной группе должно стать делом без обращения к
 * боту. Режим `all` семейной группы запускает ход на неадресованное сообщение члена семьи, а
 * причина хода (`triggeredBy`) приходит модели, чтобы та молчала, если дела в сообщении нет.
 * Внешние группы, чужие авторы и боты по-прежнему только журналируются.
 */
import type { TelegramMessage } from "eve/channels/telegram";
import { describe, expect, it } from "vitest";

import { BOT_USERNAME, groupMessage, repositories, telegramContext } from "./telegram-on-message.test-fixtures.js";
import { createTelegramMessageHandler } from "./telegram-on-message.js";

function familyGroup(messageMode: "addressed_only" | "all") {
  const repository = repositories();
  repository.telegram.findGroup.mockResolvedValue({
    familyId: "family-1",
    groupId: "group-1",
    messageMode,
    telegramChatId: "group-101",
    toolAllowlist: [],
    type: "family_private",
  });
  repository.telegram.findIdentity.mockResolvedValue({ familyId: "family-1", role: "member", userId: "user-1" });
  return repository;
}

const LIST = "Надо повесить шторы и продать опель";

describe("family group listening", () => {
  it("T03: starts a turn for an unaddressed family message in all mode and tells the model why", async () => {
    const repository = familyGroup("all");
    const result = await createTelegramMessageHandler(repository)(telegramContext().context, groupMessage(LIST));

    expect(result).not.toBeNull();
    expect(repository.groupContext.prepare).toHaveBeenCalledWith(expect.objectContaining({ triggeredBy: "unaddressed" }));
    expect(result?.auth).toMatchObject({ attributes: { telegramGroupTurnTrigger: "unaddressed" } });
    expect(repository.memoryReview.observePassiveMessage).not.toHaveBeenCalled();
  });

  it("names the concrete trigger of an addressed family message", async () => {
    const repository = familyGroup("all");
    await createTelegramMessageHandler(repository)(telegramContext().context, groupMessage(`@${BOT_USERNAME} ${LIST}`));

    expect(repository.groupContext.prepare).toHaveBeenCalledWith(expect.objectContaining({ triggeredBy: "mention" }));
  });

  it("keeps addressed_only family groups silent for unaddressed messages", async () => {
    const repository = familyGroup("addressed_only");
    await expect(createTelegramMessageHandler(repository)(telegramContext().context, groupMessage(LIST))).resolves.toBeNull();

    expect(repository.memoryReview.observePassiveMessage).toHaveBeenCalledTimes(1);
    expect(repository.telegram.findIdentity).not.toHaveBeenCalled();
  });

  it("never starts a turn for an unaddressed message in an external group, whatever its mode", async () => {
    const repository = familyGroup("all");
    repository.telegram.findGroup.mockResolvedValue({
      familyId: "family-1", groupId: "group-1", messageMode: "all", telegramChatId: "group-101",
      toolAllowlist: ["manage_shared_tasks"], type: "external",
    });
    await expect(createTelegramMessageHandler(repository)(telegramContext().context, groupMessage(LIST))).resolves.toBeNull();

    expect(repository.memoryReview.observePassiveMessage).toHaveBeenCalledTimes(1);
  });

  it("observes but does not answer an unaddressed message of someone outside the family", async () => {
    const repository = familyGroup("all");
    repository.telegram.findIdentity.mockResolvedValue(null);
    const { context, sendMessage } = telegramContext();
    await expect(createTelegramMessageHandler(repository)(context, groupMessage(LIST))).resolves.toBeNull();

    expect(repository.memoryReview.observePassiveMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("does not wake the model for another bot in the family group", async () => {
    const repository = familyGroup("all");
    const message: TelegramMessage = { ...groupMessage(LIST), from: { firstName: "Бот", id: "bot-9", isBot: true, username: "other_bot" } };
    await expect(createTelegramMessageHandler(repository)(telegramContext().context, message)).resolves.toBeNull();

    expect(repository.groupContext.prepare).not.toHaveBeenCalled();
  });

  it("keeps quiet about an unconfirmed chat and pending notices when nobody addressed the bot", async () => {
    const repository = familyGroup("all");
    repository.spaces.resolveTelegramChatMode.mockResolvedValue("unproven");
    const { context, sendMessage } = telegramContext();
    await expect(createTelegramMessageHandler(repository)(context, groupMessage(LIST))).resolves.toBeNull();

    expect(sendMessage).not.toHaveBeenCalled();
    expect(repository.profilePolicies.claimPendingGroupNotice).not.toHaveBeenCalled();
    expect(repository.memoryReview.observePassiveMessage).toHaveBeenCalledTimes(1);
  });

  it("still warns about an unconfirmed chat when the bot is addressed", async () => {
    const repository = familyGroup("all");
    repository.spaces.resolveTelegramChatMode.mockResolvedValue("unproven");
    const { context, sendMessage } = telegramContext();
    await createTelegramMessageHandler(repository)(context, groupMessage(`@${BOT_USERNAME} ${LIST}`));

    expect(sendMessage).toHaveBeenCalledWith(expect.stringContaining("Состав этого чата ещё не подтверждён"));
  });
});
