/**
 * Telegram group routing authorization boundary tests.
 *
 * Constructs covered:
 * - `createTelegramMessageHandler`: invitation, voice, HITL, and passive group routing.
 * - Unified timeline preparation retains exact forum and reply routing.
 * - Duplicate and unauthorized group updates stop before model dispatch.
 * - Another bot is journaled, observed by the memory review, and answered like an external participant.
 */
import type { TelegramMessage } from "eve/channels/telegram";
import { describe, expect, it } from "vitest";

import {
  BOT_USERNAME,
  groupMessage,
  repositories,
  telegramContext,
} from "./telegram-on-message.test-fixtures.js";
import { createTelegramMessageHandler } from "./telegram-on-message.js";

describe("createTelegramMessageHandler group routing", () => {
  it("silently consumes an invitation command posted in a group", async () => {
    const repository = repositories();
    const handler = createTelegramMessageHandler(repository);
    const { context, sendMessage } = telegramContext();

    const result = await handler(context, groupMessage(`/start ${"a".repeat(32)}`));

    expect(result).toBeNull();
    expect(repository.telegram.findIdentity).not.toHaveBeenCalled();
    expect(repository.telegram.findGroup).not.toHaveBeenCalled();
    expect(repository.family.claimInvitation).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("preserves a family-group mention carried by a transcribed voice caption", async () => {
    const repository = repositories();
    repository.telegram.findGroup.mockResolvedValue({
      familyId: "family-1",
      groupId: "group-1",
      messageMode: "addressed_only",
      telegramChatId: "group-101",
      toolAllowlist: [],
      type: "family_private",
    });
    repository.telegram.findIdentity.mockResolvedValue({
      familyId: "family-1",
      role: "member",
      userId: "user-1",
    });
    const handler = createTelegramMessageHandler(repository);
    const { context } = telegramContext();
    const message = {
      ...groupMessage("Распознанный голосовой текст"),
      caption: `@${BOT_USERNAME} ответь на запись`,
    };

    const result = await handler(context, message);

    expect(result?.auth).toMatchObject({
      attributes: {
        groupId: "group-1",
        groupType: "family_private",
        memoryScopes: ["family"],
        sandboxSessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        telegramReplyToMessageId: "1",
      },
    });
  });

  it("blocks another group member replying to a pending HITL prompt", async () => {
    const repository = repositories();
    repository.telegram.findGroup.mockResolvedValue({
      familyId: "family-1",
      groupId: "group-1",
      messageMode: "addressed_only",
      telegramChatId: "group-101",
      toolAllowlist: [],
      type: "family_private",
    });
    repository.telegram.findIdentity.mockResolvedValue({
      familyId: "family-1",
      role: "member",
      userId: "user-2",
    });
    repository.hitl.authorizeReply.mockResolvedValue("forbidden");
    const handler = createTelegramMessageHandler(repository);
    const { context, sendMessage } = telegramContext();
    const message: TelegramMessage = {
      ...groupMessage("Подтвердить"),
      chat: { id: "group-101", title: "Форум", type: "supergroup" },
      from: { firstName: "Борис", id: "telegram-202", isBot: false },
      messageId: "89",
      messageThreadId: 88,
      replyToMessage: {
        chat: { id: "group-101", type: "supergroup" },
        from: {
          firstName: "Osinara",
          id: "bot-1",
          isBot: true,
          username: BOT_USERNAME,
        },
        messageId: "88",
      },
    };

    await expect(handler(context, message)).resolves.toBeNull();
    expect(repository.hitl.authorizeReply).toHaveBeenCalledWith({
      baseContinuationToken: "group-101::88",
      telegramChatId: "group-101",
      telegramMessageId: "88",
      telegramUserId: "telegram-202",
    });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(repository.session.prepareTurn).not.toHaveBeenCalled();

    // Existing topics retain the referenced bot message's thread instead of the incoming value.
    repository.hitl.authorizeReply.mockClear();
    await handler(context, {
      ...message,
      replyToMessage: { ...message.replyToMessage!, messageThreadId: 42 },
    });
    expect(repository.hitl.authorizeReply).toHaveBeenCalledWith(expect.objectContaining({
      baseContinuationToken: "group-101:42:88",
    }));
  });

  it("records an ordinary message in the unified timeline without starting a turn", async () => {
    const repository = repositories();
    repository.telegram.findGroup.mockResolvedValue({
      familyId: "family-1",
      groupId: "group-1",
      messageMode: "addressed_only",
      telegramChatId: "group-101",
      toolAllowlist: ["remember"],
      type: "external",
    });
    const handler = createTelegramMessageHandler(repository);

    await expect(handler(telegramContext().context, groupMessage("обычная реплика"))).resolves.toBeNull();
    expect(repository.journal.record).toHaveBeenCalledTimes(1);
    expect(repository.memoryReview.observePassiveMessage).toHaveBeenCalledWith({
      groupId: "group-1",
      timelineEntryId: "00000000-0000-4000-8000-000000000010",
    });
    expect(repository.telegram.findIdentity).not.toHaveBeenCalled();
  });

  it("journals an ordinary message in all mode without starting a model turn", async () => {
    const repository = repositories();
    repository.telegram.findGroup.mockResolvedValue({
      familyId: "family-1",
      groupId: "group-1",
      messageMode: "all",
      telegramChatId: "group-101",
      toolAllowlist: ["remember"],
      type: "external",
    });
    const handler = createTelegramMessageHandler(repository);
    const message = groupMessage("контекст для будущего обращения");

    await expect(handler(telegramContext().context, message)).resolves.toBeNull();
    expect(repository.journal.record).toHaveBeenCalledWith(
      "group-1",
      message,
      expect.objectContaining({ id: "telegram-101", kind: "telegram_user" }),
    );
    expect(repository.memoryReview.observePassiveMessage).toHaveBeenCalledTimes(1);
    expect(repository.telegram.findIdentity).not.toHaveBeenCalled();
  });

  it("journals another bot and answers it while the exchange stays bounded", async () => {
    const repository = repositories();
    repository.telegram.findGroup.mockResolvedValue({
      familyId: "family-1",
      groupId: "group-1",
      messageMode: "addressed_only",
      telegramChatId: "group-101",
      toolAllowlist: [],
      type: "external",
    });
    const handler = createTelegramMessageHandler(repository);
    const message = {
      ...groupMessage(`@${BOT_USERNAME} курс валют на сегодня`),
      from: { firstName: "Курсовой бот", id: "42", isBot: true, username: "rates_bot" },
      raw: {
        date: 1_787_000_000,
        from: { first_name: "Курсовой бот", id: 42, is_bot: true, username: "rates_bot" },
      },
    } as TelegramMessage;

    const result = await handler(telegramContext().context, message);

    expect(repository.journal.record).toHaveBeenCalledWith(
      "group-1",
      message,
      expect.objectContaining({ id: "42", kind: "telegram_bot" }),
    );
    expect(result?.auth).toMatchObject({
      attributes: { memoryScopes: ["group"], role: "external" },
    });
    // An addressed message starts a turn; passive observation is for messages that do not.
  });

  it("hands a passive bot message to the quiet memory review like a human one", async () => {
    const repository = repositories();
    repository.telegram.findGroup.mockResolvedValue({
      familyId: "family-1",
      groupId: "group-1",
      messageMode: "addressed_only",
      telegramChatId: "group-101",
      toolAllowlist: [],
      type: "family_private",
    });
    const handler = createTelegramMessageHandler(repository);
    const message = {
      ...groupMessage("Завтра в Москве +12 и дождь"),
      from: { firstName: "Погодный бот", id: "42", isBot: true, username: "weather_bot" },
      raw: {
        date: 1_787_000_000,
        from: { first_name: "Погодный бот", id: 42, is_bot: true, username: "weather_bot" },
      },
    } as TelegramMessage;

    await expect(handler(telegramContext().context, message)).resolves.toBeNull();
    expect(repository.journal.record).toHaveBeenCalledWith(
      "group-1",
      message,
      expect.objectContaining({ id: "42", kind: "telegram_bot" }),
    );
    expect(repository.memoryReview.observePassiveMessage).toHaveBeenCalledWith({
      groupId: "group-1",
      timelineEntryId: "00000000-0000-4000-8000-000000000010",
    });
    expect(repository.telegram.findIdentity).not.toHaveBeenCalled();
  });

  it("adds only preceding messages from the current topic to an addressed turn", async () => {
    const repository = repositories();
    repository.telegram.findGroup.mockResolvedValue({
      familyId: "family-1",
      groupId: "group-1",
      messageMode: "all",
      telegramChatId: "group-101",
      toolAllowlist: ["remember"],
      type: "external",
    });
    repository.groupContext.prepare.mockResolvedValue({
      cursorSequence: "1",
      durableMessage: "предыдущая реплика\n\nподведи итог",
      currentMessageEnvelope: "подведи итог",
      omittedBeforeSequence: null,
      timelineOmission: null,
      visibleEntryIds: ["00000000-0000-4000-8000-000000000010"],
      visibleTimelineEntries: [],
    });
    const handler = createTelegramMessageHandler(repository);
    const message = {
      ...groupMessage(`@${BOT_USERNAME} подведи итог`),
      messageId: "41",
      messageThreadId: 42,
      raw: { date: 1_700_000_000, is_topic_message: true },
    };

    const result = await handler(telegramContext().context, message);

    expect(repository.groupContext.prepare).toHaveBeenCalledWith({
      applicationSessionId: "session-1",
      currentEntryId: "00000000-0000-4000-8000-000000000010",
      currentSenderDisplayName: "Анна",
      currentSenderUsername: "anna",
      currentSequence: "1",
      groupId: "group-1",
      attachmentReferenceAccess: { images: false, readableText: false },
      messageText: `@${BOT_USERNAME} подведи итог`,
      messageThreadId: "42",
      replyTargetUnavailable: false,
      replyToSequenceId: null,
      timezone: null,
    });
    expect(result?.message).toContain("предыдущая реплика");
    expect(result?.context?.join("\n")).not.toContain("предыдущая реплика");
  });

  it("hands the resolved turn timezone to the group timeline and the local time line", async () => {
    const repository = repositories();
    repository.telegram.findGroup.mockResolvedValue({
      familyId: "family-1",
      groupId: "group-1",
      messageMode: "addressed_only",
      telegramChatId: "group-101",
      toolAllowlist: [],
      type: "external",
    });
    repository.currentTime.findTurnTimezone.mockResolvedValue("Europe/Moscow");
    repository.groupContext.prepare.mockResolvedValue({
      cursorSequence: "1",
      durableMessage: "подведи итог",
      currentMessageEnvelope: "подведи итог",
      omittedBeforeSequence: null,
      timelineOmission: null,
      timelineTimezone: "Europe/Moscow",
      visibleEntryIds: ["00000000-0000-4000-8000-000000000010"],
      visibleTimelineEntries: [],
    });
    const handler = createTelegramMessageHandler(repository);

    const result = await handler(telegramContext().context, groupMessage(`@${BOT_USERNAME} подведи итог`));

    expect(repository.currentTime.findTurnTimezone).toHaveBeenCalledWith(null, "family-1");
    expect(repository.groupContext.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ timezone: "Europe/Moscow" }),
    );
    expect(result?.context?.join("\n")).toContain("Europe/Moscow (+03:00)");
  });

  it("passes the exact current reply relationship into the durable group envelope", async () => {
    const repository = repositories();
    repository.telegram.findGroup.mockResolvedValue({
      familyId: "family-1",
      groupId: "group-1",
      messageMode: "addressed_only",
      telegramChatId: "group-101",
      toolAllowlist: [],
      type: "external",
    });
    repository.journal.record.mockResolvedValue({
      entryId: "00000000-0000-4000-8000-000000000013",
      replyToAgent: false,
      replyTargetUnavailable: false,
      replyToSequenceId: "8",
      sequenceId: "13",
      status: "inserted",
    });
    const handler = createTelegramMessageHandler(repository);
    const message = {
      ...groupMessage(`@${BOT_USERNAME} ты видишь, на что я ответил?`),
      messageId: "13",
      replyToMessage: {
        chat: { id: "group-101", title: "Группа", type: "group" as const },
        from: { firstName: "Сергей", id: "telegram-202", isBot: false },
        messageId: "8",
      },
    };

    await handler(telegramContext().context, message);

    expect(repository.groupContext.prepare).toHaveBeenCalledWith(expect.objectContaining({
      currentEntryId: "00000000-0000-4000-8000-000000000013",
      currentSequence: "13",
      replyTargetUnavailable: false,
      replyToSequenceId: "8",
    }));
  });

  it("passes a verified raw reply snapshot when the target was not journaled", async () => {
    const repository = repositories();
    repository.telegram.findGroup.mockResolvedValue({
      familyId: "family-1",
      groupId: "group-1",
      messageMode: "addressed_only",
      telegramChatId: "group-101",
      toolAllowlist: [],
      type: "external",
    });
    repository.journal.record.mockResolvedValue({
      entryId: "00000000-0000-4000-8000-000000000013",
      replyToAgent: false,
      replyTargetUnavailable: true,
      replyToSequenceId: null,
      sequenceId: "13",
      status: "inserted",
    });
    const handler = createTelegramMessageHandler(repository);
    const message = {
      ...groupMessage(`@${BOT_USERNAME} а чо это`),
      messageId: "51002",
      raw: {
        date: 1_786_542_434,
        quote: { text: "streisand" },
        reply_to_message: {
          chat: { id: "group-101", title: "Группа", type: "group" },
          message_id: 51_001,
          sender_chat: { id: -1001, title: "nlp_daily", type: "channel", username: "nlp_daily" },
          text: "У меня настроен vless, ссылочку кинул в streisand",
        },
      },
      replyToMessage: {
        chat: { id: "group-101", title: "Группа", type: "group" as const },
        from: { firstName: "Channel", id: "telegram-channel", isBot: true },
        messageId: "51001",
      },
    };

    await handler(telegramContext().context, message);

    expect(repository.groupContext.prepare).toHaveBeenCalledWith(expect.objectContaining({
      replyTargetSnapshot: {
        contentText: "У меня настроен vless, ссылочку кинул в streisand",
        quotedText: "streisand",
        senderDisplayName: "nlp_daily",
        senderUsername: "nlp_daily",
      },
      replyTargetUnavailable: true,
      replyToSequenceId: null,
    }));
  });

  it("drops a duplicate all-mode delivery before authorization and model dispatch", async () => {
    const repository = repositories();
    repository.telegram.findGroup.mockResolvedValue({
      familyId: "family-1",
      groupId: "group-1",
      messageMode: "all",
      telegramChatId: "group-101",
      toolAllowlist: ["remember"],
      type: "external",
    });
    repository.journal.record.mockResolvedValue({
      entryId: "00000000-0000-4000-8000-000000000010",
      replyToAgent: false,
      sequenceId: "1",
      status: "duplicate",
    });
    const handler = createTelegramMessageHandler(repository);

    await expect(
      handler(telegramContext().context, groupMessage(`@${BOT_USERNAME} ответь`)),
    ).resolves.toBeNull();
    expect(repository.telegram.findIdentity).not.toHaveBeenCalled();
    expect(repository.groupContext.prepare).not.toHaveBeenCalled();
  });

  it("records an unauthorized family-group participant without granting agent access", async () => {
    const repository = repositories();
    repository.telegram.findGroup.mockResolvedValue({
      familyId: "family-1",
      groupId: "group-1",
      messageMode: "all",
      telegramChatId: "group-101",
      toolAllowlist: [],
      type: "family_private",
    });
    const handler = createTelegramMessageHandler(repository);
    const message = groupMessage(`@${BOT_USERNAME} открой семейную память`);

    await expect(handler(telegramContext().context, message)).resolves.toBeNull();
    expect(repository.journal.record).toHaveBeenCalledWith(
      "group-1",
      message,
      expect.objectContaining({ id: "telegram-101", kind: "telegram_user" }),
    );
    expect(repository.groupContext.prepare).not.toHaveBeenCalled();
    expect(repository.session.prepareTurn).not.toHaveBeenCalled();
  });

  it("does not journal messages from an unknown group", async () => {
    const repository = repositories();
    const handler = createTelegramMessageHandler(repository);

    await expect(handler(telegramContext().context, groupMessage("обычная реплика"))).resolves.toBeNull();
    expect(repository.journal.record).not.toHaveBeenCalled();
  });
});
