/**
 * Verified Telegram R3 profile-turn integration tests.
 *
 * Constructs covered:
 * - Accepted messages reactivate only the exact current timeline participant before profile read.
 * - Verified profile signals enter auth and the post-retrieval profile view enters delivery context.
 * - Application policy notice is sent once before the turn.
 */
import { describe, expect, it } from "vitest";

import { createTelegramMessageHandler } from "./telegram-on-message.js";
import {
  BOT_USERNAME,
  groupMessage,
  repositories,
  telegramContext,
} from "./telegram-on-message.test-fixtures.js";

describe("Telegram R3 profile turn", () => {
  it("creates a bounded view from verified signals and directly presents a durable policy notice", async () => {
    const repository = repositories();
    repository.telegram.findGroup.mockResolvedValue({
      familyId: "family-1",
      groupId: "group-1",
      messageMode: "addressed_only",
      telegramChatId: "group-101",
      toolAllowlist: [],
      type: "external",
    });
    repository.profilePolicies.claimPendingGroupNotice.mockResolvedValue({
      deliveryToken: "00000000-0000-4000-8000-000000000099",
      noticeRef: "notice_00000000000000000000000000000001",
      text: "Проекция профиля отключена.",
    });
    const telegram = telegramContext();
    const message = {
      ...groupMessage(`@${BOT_USERNAME} что ты знаешь о Петре?`),
      raw: {
        date: 1_700_000_000,
        entities: [{
          length: 5,
          offset: 31,
          type: "text_mention",
          user: { id: 202, is_bot: false },
        }],
      },
    };

    const result = await createTelegramMessageHandler(repository)(telegram.context, message);

    expect(repository.conversations.syncTimelineParticipants).toHaveBeenCalledWith(
      "conversation-group-1",
      ["00000000-0000-4000-8000-000000000010"],
    );
    // The profile view is assembled after retrieval, with the retrieval-related claim identities.
    expect(repository.memory.createProfile).toHaveBeenCalledWith(
      expect.objectContaining({ familyId: "family-1" }),
      expect.objectContaining({
        conversationId: "conversation-group-1",
        currentTelegramUserId: "telegram-101",
        explicitMentionTelegramUserIds: ["202"],
        retrievalClaimIds: [],
      }),
    );
    expect(telegram.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining("Проекция профиля отключена."),
    );
    expect(repository.profilePolicies.markGroupNoticePresented).toHaveBeenCalledWith({
      deliveryToken: "00000000-0000-4000-8000-000000000099",
      noticeRef: "notice_00000000000000000000000000000001",
    });
    expect(result?.auth?.attributes).toMatchObject({
      telegramConversationId: "conversation-group-1",
      telegramProfileMentionUserIds: ["202"],
      telegramTurnStartedAt: expect.any(String),
      telegramUserId: "telegram-101",
    });
    expect(result?.context?.join("\n")).toContain("verified_profile_view");
  });

  it("does not acknowledge a policy notice when Telegram delivery fails", async () => {
    const repository = repositories();
    repository.telegram.findGroup.mockResolvedValue({
      familyId: "family-1",
      groupId: "group-1",
      messageMode: "addressed_only",
      telegramChatId: "group-101",
      toolAllowlist: [],
      type: "external",
    });
    repository.profilePolicies.claimPendingGroupNotice.mockResolvedValue({
      deliveryToken: "00000000-0000-4000-8000-000000000099",
      noticeRef: "notice_00000000000000000000000000000001",
      text: "Проекция профиля включена.",
    });
    const telegram = telegramContext();
    telegram.sendMessage.mockRejectedValueOnce(new Error("Telegram unavailable"));

    await expect(createTelegramMessageHandler(repository)(telegram.context, groupMessage(
      `@${BOT_USERNAME} продолжай`,
    ))).rejects.toThrowError("Telegram unavailable");

    expect(repository.profilePolicies.markGroupNoticePresented).not.toHaveBeenCalled();
  });
});
