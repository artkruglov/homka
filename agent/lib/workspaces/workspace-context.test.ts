/**
 * Workspace authorization context tests.
 *
 * Constructs covered:
 * - A verified Telegram user resolves their own identity for the workspace.
 * - Another bot starting an external-group turn resolves the group workspace without a user:
 *   the sandbox `onSession` and the scoped file tools run for that turn instead of failing it.
 * - The bot principal is refused outside an external group, and every other service principal
 *   stays refused.
 */
import type { SessionContext } from "eve/context";
import { describe, expect, it } from "vitest";

import { requireWorkspaceAuthorization } from "./workspace-context.js";

function context(current: Record<string, unknown>): Pick<SessionContext, "session"> {
  return { session: { auth: { current, initiator: current } } } as unknown as Pick<SessionContext, "session">;
}

const GROUP_ATTRIBUTES = {
  familyId: "family-1",
  groupId: "group-1",
  groupType: "external",
  role: "external",
  telegramChatType: "supergroup",
};

describe("requireWorkspaceAuthorization", () => {
  it("resolves a verified user with their identity", () => {
    expect(requireWorkspaceAuthorization(context({
      attributes: { familyId: "family-1", role: "owner", telegramChatType: "private" },
      authenticator: "telegram",
      principalId: "user-1",
      principalType: "user",
    }))).toEqual({
      familyId: "family-1",
      groupId: null,
      groupType: null,
      role: "owner",
      telegramChatType: "private",
      userId: "user-1",
    });
  });

  it("resolves the group workspace for a turn started by another bot", () => {
    expect(requireWorkspaceAuthorization(context({
      attributes: { ...GROUP_ATTRIBUTES, telegramActorId: "8532941015", telegramActorKind: "telegram_bot" },
      authenticator: "telegram",
      principalId: "telegram-bot:8532941015",
      principalType: "service",
    }))).toEqual({
      familyId: "family-1",
      groupId: "group-1",
      groupType: "external",
      role: "external",
      telegramChatType: "supergroup",
      userId: null,
    });
  });

  it.each([
    { name: "a bot in a private chat", overrides: { role: "owner", telegramChatType: "private" }, principalId: "telegram-bot:1" },
    { name: "a bot with a member role", overrides: { role: "member" }, principalId: "telegram-bot:1" },
    { name: "a channel principal", overrides: {}, principalId: "telegram-channel:-100123" },
  ])("refuses $name", ({ overrides, principalId }) => {
    expect(() => requireWorkspaceAuthorization(context({
      attributes: { ...GROUP_ATTRIBUTES, ...overrides },
      authenticator: "telegram",
      principalId,
      principalType: "service",
    }))).toThrow(/AGENT_WORKSPACE_CONTEXT_INVALID/u);
  });
});
