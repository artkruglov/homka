/**
 * Google Workspace surface gating tests.
 *
 * Constructs covered:
 * - Without OAuth credentials the three Google tools have no descriptor in any trusted mode.
 * - The nineteen gws skill packages are not issued to a session that cannot connect Google.
 * - Every other trusted tool and skill stays available.
 */
import type { SessionAuth } from "eve/context";
import { describe, expect, it, vi } from "vitest";

vi.mock("./google-workspace-availability.js", () => ({
  GOOGLE_WORKSPACE_AVAILABLE: false,
}));

import { resolveTrustedSessionSkills } from "../group-skills/group-skill-resolver.js";
import { TRUSTED_GOOGLE_WORKSPACE_SKILL_NAMES } from "../group-skills/trusted-google-workspace-skills.js";
import { buildModeToolSurface } from "../tool-policy/mode-tool-surface.js";

const GOOGLE_TOOLS = [
  "execute_google_workspace",
  "manage_gmail_message",
  "manage_google_workspace_connection",
] as const;

function privateAuth(): SessionAuth {
  const caller = {
    attributes: {
      memoryScopes: ["personal", "family"],
      telegramActorId: "101",
      telegramActorKind: "telegram_user",
      telegramChatType: "private",
      telegramUserId: "101",
    },
    authenticator: "telegram",
    principalId: "user-1",
    principalType: "user" as const,
  };
  return { current: caller, initiator: caller } as SessionAuth;
}

describe("Google Workspace surface without OAuth credentials", () => {
  it("omits the Google tools from private and family modes", () => {
    for (const environment of ["private", "family"] as const) {
      const surface = buildModeToolSurface({ environment });
      for (const name of GOOGLE_TOOLS) expect(surface, `${environment}.${name}`).not.toHaveProperty(name);
      expect(surface).toHaveProperty("remember");
      expect(surface).toHaveProperty("manage_reminder");
    }
  });

  it("does not issue gws skill packages to a trusted session", () => {
    const skills = resolveTrustedSessionSkills(privateAuth());
    for (const name of TRUSTED_GOOGLE_WORKSPACE_SKILL_NAMES) expect(skills).not.toHaveProperty(name);
  });
});
