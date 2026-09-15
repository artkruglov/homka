/**
 * Telegram durable session actor validation tests.
 *
 * Constructs covered:
 * - Explicit Telegram user and channel auth recover their exact actor identity.
 * - Sessions without the deployed actor contract are intentionally invalidated.
 * - Channel identity cannot be projected through a user principal or Telegram user attribute.
 */
import type { SessionAuth } from "eve/context";
import { describe, expect, it } from "vitest";

import { resolveTelegramSessionActor } from "./telegram-session-actor.js";

function auth(current: Record<string, unknown>): SessionAuth {
  return { current, initiator: current } as unknown as SessionAuth;
}

describe("resolveTelegramSessionActor", () => {
  it("resolves an explicit Telegram user actor", () => {
    expect(resolveTelegramSessionActor(auth({
      attributes: {
        telegramActorId: "101",
        telegramActorKind: "telegram_user",
        telegramUserId: "101",
      },
      authenticator: "telegram",
      principalId: "user-1",
      principalType: "user",
    }))).toEqual({ id: "101", kind: "telegram_user" });
  });

  it("resolves an exact Telegram channel service actor", () => {
    expect(resolveTelegramSessionActor(auth({
      attributes: {
        telegramActorId: "-1001000000002",
        telegramActorKind: "telegram_channel",
      },
      authenticator: "telegram",
      principalId: "telegram-channel:-1001000000002",
      principalType: "service",
    }))).toEqual({ id: "-1001000000002", kind: "telegram_channel" });
  });

  it("resolves another bot as an exact service actor", () => {
    expect(resolveTelegramSessionActor(auth({
      attributes: {
        telegramActorId: "7000000001",
        telegramActorKind: "telegram_bot",
      },
      authenticator: "telegram",
      principalId: "telegram-bot:7000000001",
      principalType: "service",
    }))).toEqual({ id: "7000000001", kind: "telegram_bot" });
  });

  it.each([
    { principalId: "telegram-bot:7000000001", principalType: "user", telegramUserId: undefined },
    { principalId: "telegram-bot:7000000001", principalType: "service", telegramUserId: "7000000001" },
    { principalId: "user-1", principalType: "service", telegramUserId: undefined },
  ])("rejects a bot with conflicting principal shape: %o", ({ principalId, principalType, telegramUserId }) => {
    expect(resolveTelegramSessionActor(auth({
      attributes: {
        telegramActorId: "7000000001",
        telegramActorKind: "telegram_bot",
        ...(telegramUserId === undefined ? {} : { telegramUserId }),
      },
      authenticator: "telegram",
      principalId,
      principalType,
    }))).toBeNull();
  });

  it("invalidates a session that has only the former Telegram user attribute", () => {
    expect(resolveTelegramSessionActor(auth({
      attributes: { telegramUserId: "101" },
      authenticator: "telegram",
      principalId: "user-1",
      principalType: "user",
    }))).toBeNull();
  });

  it.each([
    { principalType: "user", telegramUserId: undefined },
    { principalType: "service", telegramUserId: "101" },
  ])("rejects a channel with conflicting principal shape", ({ principalType, telegramUserId }) => {
    expect(resolveTelegramSessionActor(auth({
      attributes: {
        telegramActorId: "-1001000000002",
        telegramActorKind: "telegram_channel",
        ...(telegramUserId === undefined ? {} : { telegramUserId }),
      },
      authenticator: "telegram",
      principalId: "telegram-channel:-1001000000002",
      principalType,
    }))).toBeNull();
  });
});
