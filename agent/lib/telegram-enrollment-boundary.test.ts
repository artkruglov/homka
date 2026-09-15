/**
 * Telegram enrollment boundary tests.
 *
 * Constructs covered:
 * - `handleTelegramEnrollmentBoundary`: accepts exact bootstrap commands without model dispatch.
 * - Ordinary private text cannot consume a bootstrap attempt.
 * - Existing identities cannot turn invitation deep links into conversation content.
 */
import { describe, expect, it, vi } from "vitest";

import { handleTelegramEnrollmentBoundary } from "./telegram-enrollment-boundary.js";
import {
  privateMessage,
  repositories,
  telegramContext,
} from "./telegram-on-message.test-fixtures.js";

describe("handleTelegramEnrollmentBoundary", () => {
  it("claims an owner only from the exact bootstrap command", async () => {
    const repository = repositories();
    const code = "a".repeat(43);
    repository.telegram.hasOwner.mockResolvedValue(false);
    repository.telegram.claimFirstOwner.mockResolvedValue("claimed");
    const { context, sendMessage } = telegramContext();

    const consumed = await handleTelegramEnrollmentBoundary({
      ctx: context,
      identity: null,
      invitationCode: null,
      message: privateMessage(`/start ${code}`),
      repositories: repository,
    });

    expect(consumed).toBe(true);
    expect(repository.telegram.claimFirstOwner).toHaveBeenCalledWith(code, {
      displayName: "Анна",
      telegramUserId: "telegram-101",
      username: "anna",
    });
    expect(sendMessage).toHaveBeenCalledWith(
      "Владелец создан. Семейный агент готов к настройке.",
    );
  });

  it("does not spend bootstrap attempts on ordinary private text", async () => {
    const repository = repositories();
    repository.telegram.hasOwner.mockResolvedValue(false);
    const { context, sendMessage } = telegramContext();

    const consumed = await handleTelegramEnrollmentBoundary({
      ctx: context,
      identity: null,
      invitationCode: null,
      message: privateMessage("привет"),
      repositories: repository,
    });

    expect(consumed).toBe(true);
    expect(repository.telegram.claimFirstOwner).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      "AGENT_BOOTSTRAP_COMMAND_INVALID: Откройте одноразовую ссылку владельца, полученную на сервере.",
    );
  });

  it("consumes an existing member invitation without claiming it", async () => {
    const repository = repositories();
    const { context, sendMessage } = telegramContext();

    const consumed = await handleTelegramEnrollmentBoundary({
      ctx: context,
      identity: { familyId: "family-1", role: "member", userId: "user-1" },
      invitationCode: "a".repeat(32),
      message: privateMessage(`/start ${"a".repeat(32)}`),
      repositories: repository,
    });

    expect(consumed).toBe(true);
    expect(repository.family.claimInvitation).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      "AGENT_INVITATION_NOT_APPLICABLE: Вы уже подключены к семейному агенту.",
    );
  });
});
