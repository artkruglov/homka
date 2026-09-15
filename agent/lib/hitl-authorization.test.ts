/**
 * Telegram HITL authorization regression tests.
 *
 * Constructs covered:
 * - Owner and memory guards accept the freshly authenticated callback caller.
 * - A non-owner callback caller cannot inherit the durable initiator's owner role.
 */
import type { SessionContext } from "eve/context";
import { describe, expect, it } from "vitest";

import { requirePrivateTelegramOwner } from "./family-context.js";
import { requireMemoryAuthorization } from "./memory-context.js";

function context(input: {
  currentRole?: "member" | "owner";
  spaceId?: string;
  spacePolicyVersion?: string;
  initiatorRole?: "member" | "owner";
}): SessionContext {
  const auth = (role: "member" | "owner" | undefined, principalId: string) =>
    role
      ? {
          attributes: {
            familyId: "family-1",
            ...(input.spaceId === undefined ? {} : { spaceId: input.spaceId }),
            ...(input.spacePolicyVersion === undefined ? {} : { spacePolicyVersion: input.spacePolicyVersion }),
            memoryScopes: ["personal", "family"],
            role,
            telegramChatId: "101",
            telegramActorId: principalId,
            telegramActorKind: "telegram_user",
            telegramChatType: "private",
            telegramUserId: principalId,
          },
          authenticator: "telegram",
          principalId,
          principalType: "user" as const,
        }
      : null;

  return {
    session: {
      auth: {
        current: auth(input.currentRole, "current-user"),
        initiator: auth(input.initiatorRole, "initiator-user"),
      },
      id: "session-1",
      turn: { id: "turn-1", sequence: 1 },
    },
  } as unknown as SessionContext;
}

describe("HITL authorization", () => {
  it("authorizes the current private owner and memory scope after approval resumes", () => {
    const ctx = context({ currentRole: "owner" });

    expect(requirePrivateTelegramOwner(ctx)).toMatchObject({
      role: "owner",
      telegramChatId: "101",
      userId: "current-user",
    });
    expect(requireMemoryAuthorization(ctx)).toMatchObject({
      familyId: "family-1",
      scopes: ["personal", "family"],
      userId: "current-user",
    });
  });

  it("preserves the verified space in memory authorization", () => {
    const spaceId = "e86a3b4e-51c2-4c63-877f-c116b0e03517";
    expect(requireMemoryAuthorization(context({ currentRole: "owner", spaceId, spacePolicyVersion: "3" })))
      .toMatchObject({ space: { spaceId, policyVersion: 3 } });
  });

  it("rejects an incomplete space instead of dropping back to family memory", () => {
    expect(() => requireMemoryAuthorization(context({ currentRole: "owner", spacePolicyVersion: "3" })))
      .toThrow(/AGENT_MEMORY_SPACE_CONTEXT_INVALID/);
  });

  it("rejects a current member even when the initiator was an owner", () => {
    const ctx = context({ currentRole: "member", initiatorRole: "owner" });

    expect(() => requirePrivateTelegramOwner(ctx)).toThrowError(/AGENT_OWNER_REQUIRED/);
  });
});
