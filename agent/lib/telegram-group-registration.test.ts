/**
 * Telegram group registration input tests.
 *
 * Constructs covered:
 * - `telegramGroupRegistrationInputSchema`: accepts Telegram group IDs from model JSON.
 * - Numeric IDs are normalized to lossless strings before repository access.
 * - Message collection mode is explicit and has no implicit default.
 * - Owner-only dispatch is valid only for isolated external groups.
 */
import { describe, expect, it } from "vitest";

import { telegramGroupRegistrationInputSchema } from "./telegram-group-registration.js";

const baseInput = {
  messageMode: "all" as const,
  title: "Семейная группа",
  type: "family_private" as const,
};

const externalInput = {
  ...baseInput,
  title: "Внешняя группа",
  toolAllowlist: ["remember", "list_memories"],
  type: "external" as const,
};

describe("telegramGroupRegistrationInputSchema", () => {
  it("rejects numeric Telegram group IDs to prevent JSON precision loss", () => {
    expect(() => telegramGroupRegistrationInputSchema.parse({
      ...baseInput,
      telegramChatId: -1001234567890,
    })).toThrow();
  });

  it("keeps a canonical string Telegram group ID", () => {
    expect(
      telegramGroupRegistrationInputSchema.parse({
        ...baseInput,
        telegramChatId: "-1001234567890",
      }),
    ).toEqual({ ...baseInput, telegramChatId: "-1001234567890" });
  });

  it("rejects private and every numeric ID representation", () => {
    expect(() =>
      telegramGroupRegistrationInputSchema.parse({ ...baseInput, telegramChatId: 123456789 }),
    ).toThrow();
    expect(() =>
      telegramGroupRegistrationInputSchema.parse({ ...baseInput, telegramChatId: -100.5 }),
    ).toThrow();
    expect(() =>
      telegramGroupRegistrationInputSchema.parse({
        ...baseInput,
        telegramChatId: Number.MIN_SAFE_INTEGER - 1,
      }),
    ).toThrow();
  });

  it("requires an explicit supported message mode", () => {
    const { messageMode: _messageMode, ...withoutMode } = baseInput;

    expect(() =>
      telegramGroupRegistrationInputSchema.parse({
        ...withoutMode,
        telegramChatId: "-1001234567890",
      }),
    ).toThrow();
    expect(() =>
      telegramGroupRegistrationInputSchema.parse({
        ...baseInput,
        messageMode: "sometimes",
        telegramChatId: "-1001234567890",
      }),
    ).toThrow();
  });

  it("requires a validated explicit allowlist for every external group", () => {
    expect(
      telegramGroupRegistrationInputSchema.parse({
        ...externalInput,
        telegramChatId: "-1001234567890",
      }),
    ).toEqual({ ...externalInput, telegramChatId: "-1001234567890" });

    const { toolAllowlist: _toolAllowlist, ...withoutAllowlist } = externalInput;
    expect(() =>
      telegramGroupRegistrationInputSchema.parse({
        ...withoutAllowlist,
        telegramChatId: "-1001234567890",
      }),
    ).toThrow();
    expect(() =>
      telegramGroupRegistrationInputSchema.parse({
        ...externalInput,
        telegramChatId: "-1001234567890",
        toolAllowlist: ["unknown_tool"],
      }),
    ).toThrow();
    expect(() =>
      telegramGroupRegistrationInputSchema.parse({
        ...externalInput,
        telegramChatId: "-1001234567890",
        toolAllowlist: ["remember", "remember"],
      }),
    ).toThrow();
  });

  it.each(["external_private", "external_public"])(
    "rejects the removed legacy group type %s",
    (type) => {
      expect(() => telegramGroupRegistrationInputSchema.parse({
        ...externalInput,
        telegramChatId: "-1001234567890",
        type,
      })).toThrow();
    },
  );

  it("accepts owner-only dispatch only for external groups", () => {
    expect(
      telegramGroupRegistrationInputSchema.parse({
        ...externalInput,
        messageMode: "owner_only",
        telegramChatId: "-1001234567890",
      }),
    ).toMatchObject({ messageMode: "owner_only", type: "external" });

    expect(() =>
      telegramGroupRegistrationInputSchema.parse({
        ...baseInput,
        messageMode: "owner_only",
        telegramChatId: "-1001234567890",
      })
    ).toThrow();
  });

  it("rejects the obsolete allowlist field for a family group", () => {
    expect(() =>
      telegramGroupRegistrationInputSchema.parse({
        ...baseInput,
        telegramChatId: "-1001234567890",
        toolAllowlist: ["remember"],
      }),
    ).toThrow();
  });
});
