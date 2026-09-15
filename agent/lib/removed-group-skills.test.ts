/** Removed custom-group-skill surface regression tests. */
import { access, readFile } from "node:fs/promises";

import type { ToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const listStatuses = vi.hoisted(() => vi.fn());

vi.mock("./telegram-group-administration-repository.js", () => ({
  telegramGroupAdministrationRepository: {
    listStatuses,
    registerGroup: vi.fn(),
    removeRegistration: vi.fn(),
    requestGroupSessionRotation: vi.fn(),
    updatePolicy: vi.fn(),
  },
}));

import manageTelegramGroup from "./tools/manage_telegram_group.js";

function context(): ToolContext {
  const caller = {
    attributes: {
      familyId: "family-1",
      memoryScopes: ["personal", "family"],
      role: "owner",
      telegramChatId: "101",
      telegramChatType: "private",
    },
    authenticator: "telegram",
    principalId: "owner-1",
    principalType: "user" as const,
  };
  return {
    session: { auth: { current: caller, initiator: caller }, id: "session-1" },
  } as unknown as ToolContext;
}

describe("removed custom group skills", () => {
  beforeEach(() => listStatuses.mockReset());

  it("does not publish the removed action or field", () => {
    const schema = z.toJSONSchema(manageTelegramGroup.inputSchema as z.ZodType) as {
      properties: Record<string, { enum?: string[] }>;
    };

    expect(schema.properties.action?.enum).not.toContain("update_skills");
    expect(schema.properties).not.toHaveProperty("skillAllowlist");
    expect(manageTelegramGroup.description).not.toContain("update_skills");
    expect(manageTelegramGroup.description).not.toContain("pohuy");
  });

  it("does not expose a historical persisted grant through status", async () => {
    listStatuses.mockResolvedValue([{
      active: true,
      messageMode: "all",
      skillAllowlist: ["pohuy"],
      telegramChatId: "-1001234567890",
      title: "Внешняя",
      toolAllowlist: [],
      type: "external",
    }]);

    const result = await manageTelegramGroup.execute(
      { action: "status" },
      context(),
    ) as unknown as { groups: Record<string, unknown>[] };

    expect(result).not.toHaveProperty("availableSafeSkills");
    expect(result.groups[0]).not.toHaveProperty("skillAllowlist");
  });

  it("has no custom-skill DTO, auth or compatibility surface", async () => {
    const runtimePaths = [
      "agent/lib/family-access.ts",
      "agent/lib/group-skills/group-load-skill-tool.ts",
      "agent/lib/prompt/mode-instructions.ts",
      "agent/lib/prompt/turn-blocks.ts",
      "agent/lib/telegram-group-administration-repository.ts",
      "agent/lib/telegram-group-policy-snapshot.ts",
      "agent/lib/telegram-on-message.ts",
      "agent/lib/telegram-repository.ts",
      "agent/lib/tool-policy/external-group-capability-instructions.ts",
      "agent/lib/tool-policy/external-group-file-tools.ts",
      "agent/lib/tool-policy/mode-tool-surface.ts",
    ] as const;
    const sources = await Promise.all(runtimePaths.map((path) => readFile(path, "utf8")));

    for (const source of sources) {
      expect(source).not.toMatch(/skillAllowlist|loadGroupSkillAllowlist|GroupSafeSkill/u);
    }
    await expect(access("agent/lib/group-skills/group-skill-catalog.ts")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
