/**
 * Authored skill resolver tests.
 *
 * Constructs covered:
 * - The owner's private chat and the family group get every active package as a named skill.
 * - A member's private chat, an external group, silent review and subagents get nothing.
 * - Packages without files omit the `files` key so Eve writes nothing extra to the sandbox.
 */
import type { SessionAuth } from "eve/context";
import { describe, expect, it, vi } from "vitest";

import { createAuthoredTurnSkillResolver } from "./authored-skill-resolver.js";

function auth(attributes: Record<string, unknown>): SessionAuth {
  return {
    current: {
      attributes: { familyId: "family-1", telegramActorId: "101", telegramActorKind: "telegram_user", telegramUserId: "101", ...attributes },
      authenticator: "telegram",
      principalId: "user-1",
      principalType: "user",
    },
    initiator: null,
  };
}

const PRIVATE_OWNER = auth({ memoryScopes: ["personal", "family"], role: "owner", telegramChatType: "private" });
const PRIVATE_MEMBER = auth({ memoryScopes: ["personal", "family"], role: "member", telegramChatType: "private" });
const FAMILY = auth({ groupId: "group-1", groupType: "family_private", memoryScopes: ["family"], role: "member", telegramChatType: "supergroup" });
const EXTERNAL = auth({ groupId: "group-2", groupType: "external", memoryScopes: ["group"], role: "external", telegramChatType: "supergroup" });

const PACKAGES = [
  { description: "Открытка", files: { "references/flux-card.md": "x" }, markdown: "## Шаги", name: "birthday-card" },
  { description: "Сводка", files: {}, markdown: "## Шаги", name: "club-digest" },
];

describe("authored skill resolver", () => {
  it("resolves the family library for the owner's private chat and the family group", async () => {
    const activePackages = vi.fn().mockResolvedValue(PACKAGES);
    const resolve = createAuthoredTurnSkillResolver({ activePackages });

    const privateSkills = await resolve(PRIVATE_OWNER);
    const familySkills = await resolve(FAMILY);

    expect(activePackages).toHaveBeenCalledWith("family-1");
    expect(Object.keys(privateSkills)).toEqual(["birthday-card", "club-digest"]);
    expect(privateSkills["birthday-card"]).toMatchObject({
      description: "Открытка", files: { "references/flux-card.md": "x" }, markdown: "## Шаги",
    });
    expect(privateSkills["club-digest"]).not.toHaveProperty("files");
    expect(Object.keys(familySkills)).toEqual(["birthday-card", "club-digest"]);
  });

  it("gives nothing to members' private chats, external groups, review and subagents", async () => {
    const activePackages = vi.fn().mockResolvedValue(PACKAGES);
    const resolve = createAuthoredTurnSkillResolver({ activePackages });

    await expect(resolve(PRIVATE_MEMBER)).resolves.toEqual({});
    await expect(resolve(EXTERNAL)).resolves.toEqual({});
    await expect(resolve(FAMILY, { memoryReview: true })).resolves.toEqual({});
    await expect(resolve(PRIVATE_OWNER, { subagent: true })).resolves.toEqual({});
    expect(activePackages).not.toHaveBeenCalled();
  });
});
