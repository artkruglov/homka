/**
 * Installer Telegram identity tests.
 *
 * Constructs covered:
 * - `validateTelegramBot`: validates token shape and derives the trusted username from getMe.
 * - Telegram response validation: rejects API failures and identity mismatches.
 */
import { describe, expect, it, vi } from "vitest";

import { validateTelegramBot } from "./telegram.js";

describe("provider installer Telegram validation", () => {
  it("derives the bot username only from a successful getMe response", async () => {
    const getMe = vi.fn().mockResolvedValue({
      ok: true,
      result: { id: 123456, is_bot: true, username: "Osinara_Test_Bot" },
    });

    await expect(validateTelegramBot("123456:Abc_def-123", getMe)).resolves.toEqual({
      id: 123456,
      username: "Osinara_Test_Bot",
    });
  });

  it("rejects malformed tokens without contacting Telegram", async () => {
    const getMe = vi.fn();
    await expect(validateTelegramBot("not-a-token", getMe)).rejects.toMatchObject({
      code: "OSINARA_INSTALL_TELEGRAM_TOKEN_INVALID",
    });
    expect(getMe).not.toHaveBeenCalled();
  });

  it("rejects a response whose bot id does not match the token", async () => {
    await expect(
      validateTelegramBot(
        "123456:Abc_def-123",
        vi.fn().mockResolvedValue({
          ok: true,
          result: { id: 654321, is_bot: true, username: "Osinara_Test_Bot" },
        }),
      ),
    ).rejects.toMatchObject({ code: "OSINARA_INSTALL_TELEGRAM_IDENTITY_INVALID" });
  });

  it("rejects unsuccessful or malformed getMe responses", async () => {
    await expect(
      validateTelegramBot(
        "123456:Abc_def-123",
        vi.fn().mockResolvedValue({ ok: false, description: "Unauthorized" }),
      ),
    ).rejects.toMatchObject({ code: "OSINARA_INSTALL_TELEGRAM_VALIDATION_FAILED" });
  });
});
