/**
 * Group skill policy tests.
 *
 * Constructs covered:
 * - Trusted skills are session-stable while external imagegen follows the turn capability snapshot.
 */
import type { SessionAuth } from "eve/context";
import { describe, expect, it, vi } from "vitest";

vi.mock("../image-generation/image-generation-availability.js", () => ({
  IMAGE_GENERATION_AVAILABLE: true,
}));
vi.mock("../google-workspace/google-workspace-availability.js", () => ({
  GOOGLE_WORKSPACE_AVAILABLE: true,
}));

import { TRUSTED_GOOGLE_WORKSPACE_SKILL_NAMES } from "./trusted-google-workspace-skills.js";
import {
  createExternalTurnSkillResolver,
  resolveTrustedSessionSkills,
} from "./group-skill-resolver.js";

const packagesForGroup = vi.fn().mockResolvedValue([]);
const resolveExternalTurnSkills = createExternalTurnSkillResolver({ packagesForGroup });

function auth(
  environment: "external" | "family" | "private",
  toolAllowlist: string[] = [],
): SessionAuth {
  const group = environment !== "private";
  const caller = {
    attributes: {
      familyId: "family-1",
      ...(group ? { groupId: "00000000-0000-4000-8000-000000000041" } : {}),
      ...(group ? { groupType: environment === "external" ? "external" : "family_private" } : {}),
      memoryScopes: environment === "private"
        ? ["personal", "family"]
        : [environment === "external" ? "group" : "family"],
      ...(group ? { toolAllowlist } : {}),
      telegramActorId: "101",
      telegramActorKind: "telegram_user",
      telegramChatType: group ? "group" : "private",
      telegramUserId: "101",
    },
    authenticator: "telegram",
    principalId: "user-1",
    principalType: "user" as const,
  };
  return { current: caller, initiator: caller } as SessionAuth;
}

describe("group skill policy", () => {
  it("does not resurrect a removed skill from an external auth snapshot", async () => {
    const external = auth("external");
    Object.assign(external.current!.attributes, { skillAllowlist: ["pohuy"] });
    await expect(resolveExternalTurnSkills(external)).resolves.toEqual({});
  });

  it("adds authored skills granted to the group and skips them for scheduled runs and children", async () => {
    const pkg = { description: "Сводка недели", files: {}, markdown: "## Шаги\n1. `web_search`", name: "weekly-digest" };
    packagesForGroup.mockResolvedValueOnce([pkg]).mockResolvedValueOnce([pkg]).mockResolvedValueOnce([pkg]);
    const external = auth("external", ["web_search"]);

    await expect(resolveExternalTurnSkills(external)).resolves.toHaveProperty("weekly-digest");
    expect(packagesForGroup).toHaveBeenCalledWith({ familyId: "family-1", groupId: "00000000-0000-4000-8000-000000000041" });
    await expect(resolveExternalTurnSkills(external, { scheduledRun: true })).resolves.not.toHaveProperty("weekly-digest");
    await expect(resolveExternalTurnSkills(external, { subagent: true })).resolves.not.toHaveProperty("weekly-digest");
  });

  it("leaves the group without authored skills when the grant lookup fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    packagesForGroup.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(resolveExternalTurnSkills(auth("external", ["generate_image"]))).resolves.toHaveProperty("imagegen");
  });

  it("keeps trusted skills available in a private session", () => {
    const skills = resolveTrustedSessionSkills(auth("private"));
    expect(skills).toHaveProperty("imagegen");
    expect(skills).not.toHaveProperty("pohuy");
    expect(resolveTrustedSessionSkills(auth("private"), { subagent: true }))
      .not.toHaveProperty("imagegen");
    expect(resolveTrustedSessionSkills(auth("private"), { scheduledRun: true }))
      .toHaveProperty("imagegen");
    for (const name of TRUSTED_GOOGLE_WORKSPACE_SKILL_NAMES) expect(skills).toHaveProperty(name);
  });

  it("ties external imagegen instructions to the generate_image capability", async () => {
    await expect(resolveExternalTurnSkills(auth("external", ["generate_image"])))
      .resolves.toHaveProperty("imagegen");
    await expect(resolveExternalTurnSkills(auth("external", ["generate_image"]), {
      scheduledRun: true,
    })).resolves.not.toHaveProperty("imagegen");
    await expect(resolveExternalTurnSkills(auth("external", ["generate_image"]), {
      subagent: true,
    })).resolves.not.toHaveProperty("imagegen");
    await expect(resolveExternalTurnSkills(auth("external"))).resolves.not.toHaveProperty("imagegen");
  });

  it("does not advertise trusted-only Google Workspace skills to an external group", async () => {
    const skills = await resolveExternalTurnSkills(auth("external"));

    expect(skills).not.toHaveProperty("pohuy");
    for (const name of TRUSTED_GOOGLE_WORKSPACE_SKILL_NAMES) {
      expect(skills).not.toHaveProperty(name);
    }
  });
});
