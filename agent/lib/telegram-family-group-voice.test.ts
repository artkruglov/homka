/**
 * Voice in the family group (W15 in docs/family-completion-plan.ru.md).
 *
 * Голосовое в семейной группе раньше расшифровывалось только в ответ на сообщение бота: имя,
 * сказанное голосом, распознать было нечем, и в журнал ложилась пустая запись. Теперь решение о
 * расшифровке не зависит от обращения, шлюзом остаётся авторизация голоса (только семейная
 * группа и её участник), а адресация считается по тексту расшифровки.
 */
import { describe, expect, it, vi } from "vitest";

import { groupMessage, repositories, telegramContext } from "./telegram-on-message.test-fixtures.js";
import { createTelegramMessageHandler } from "./telegram-on-message.js";
import { shouldTranscribeVoice } from "./telegram-ingress-update.js";
import { createTelegramVoiceAuthorizer } from "./telegram-voice-authorization.js";

const voice = (type: "private" | "group" | "supergroup" | "channel") => ({ chat: { id: "-1001", type } });

describe("family group voice", () => {
  it("W15: asks for a transcript of every group voice and leaves the decision to the voice authorizer", () => {
    expect(shouldTranscribeVoice(voice("supergroup"))).toBe(true);
    expect(shouldTranscribeVoice(voice("group"))).toBe(true);
    expect(shouldTranscribeVoice(voice("private"))).toBe(true);
    expect(shouldTranscribeVoice(voice("channel"))).toBe(false);
  });

  it("authorizes a family member's voice in the family group", async () => {
    const authorize = createTelegramVoiceAuthorizer({
      findGroup: vi.fn().mockResolvedValue({
        familyId: "family-1", groupId: "group-1", messageMode: "addressed_only", telegramChatId: "-1001",
        toolAllowlist: [], type: "family_private",
      }),
      findIdentity: vi.fn().mockResolvedValue({ familyId: "family-1", role: "member", userId: "user-1" }),
    });

    await expect(authorize({ chat: { id: "-1001", type: "supergroup" }, from: { id: "101", isBot: false } }))
      .resolves.toBe(true);
  });

  it("starts a turn when the transcript names the agent, even without a caption", async () => {
    const repository = repositories();
    repository.telegram.findGroup.mockResolvedValue({
      familyId: "family-1", groupId: "group-1", messageMode: "addressed_only", telegramChatId: "group-101",
      toolAllowlist: [], type: "family_private",
    });
    repository.telegram.findIdentity.mockResolvedValue({ familyId: "family-1", role: "member", userId: "user-1" });
    const transcribed = { ...groupMessage("Хомка, запиши купить батарейки"), raw: { date: 1_700_000_000, voice: { file_id: "v" } } };

    const result = await createTelegramMessageHandler(repository)(telegramContext().context, transcribed);

    expect(result).not.toBeNull();
    expect(repository.groupContext.prepare).toHaveBeenCalledWith(expect.objectContaining({ triggeredBy: "name_in_text" }));
  });

  it("journals a transcript without the agent name and does not wake the model in addressed_only", async () => {
    const repository = repositories();
    repository.telegram.findGroup.mockResolvedValue({
      familyId: "family-1", groupId: "group-1", messageMode: "addressed_only", telegramChatId: "group-101",
      toolAllowlist: [], type: "family_private",
    });
    const transcribed = { ...groupMessage("надо повесить шторы"), raw: { date: 1_700_000_000, voice: { file_id: "v" } } };

    await expect(createTelegramMessageHandler(repository)(telegramContext().context, transcribed)).resolves.toBeNull();
    expect(repository.journal.record).toHaveBeenCalledWith("group-1", transcribed, expect.anything());
    expect(repository.memoryReview.observePassiveMessage).toHaveBeenCalledTimes(1);
  });
});
