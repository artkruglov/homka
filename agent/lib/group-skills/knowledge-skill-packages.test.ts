/**
 * Knowledge skill package tests.
 *
 * Constructs covered:
 * - Both analyst skills load from `agent/skills/<name>/` with the SKILL.md description, the body
 *   without frontmatter and every reference file under `references/`.
 * - The external turn resolver hands them to the sandbox only with the live `web_search` grant,
 *   because Eve's public `load_skill` executor knows dynamic packages alone, not compiled static
 *   skills; without the package the analyst skills failed with AGENT_TOOL_DEPENDENCY_FAILED.
 */
import type { SessionAuth } from "eve/context";
import { describe, expect, it } from "vitest";

import { createExternalTurnSkillResolver } from "./group-skill-resolver.js";
import { KNOWLEDGE_SKILL_DEFINITIONS } from "./knowledge-skill-packages.js";

function externalAuth(toolAllowlist: string[]): SessionAuth {
  return {
    current: {
      attributes: { familyId: "family-1", groupId: "group-1", groupType: "external", memoryScopes: ["group"], role: "external", telegramActorId: "101", telegramActorKind: "telegram_user", telegramChatType: "supergroup", telegramUserId: "101", toolAllowlist },
      authenticator: "telegram",
      principalId: "user-1",
      principalType: "user",
    },
    initiator: null,
  } as unknown as SessionAuth;
}

describe("knowledge skill packages", () => {
  it("loads both analyst skills with description, body and references", () => {
    for (const name of ["auto-analyst", "policy-finance-analyst"] as const) {
      const definition = KNOWLEDGE_SKILL_DEFINITIONS[name];
      expect(definition.description.length).toBeGreaterThan(40);
      expect(definition.markdown.startsWith("---")).toBe(false);
      expect(definition.markdown).toContain("# ");
      expect(Object.keys(definition.files ?? {}).some((path) => path.startsWith("references/") && path.endsWith(".md"))).toBe(true);
    }
  });

  it("reaches the external sandbox only with the web_search grant", async () => {
    const resolve = createExternalTurnSkillResolver({ packagesForGroup: async () => [] });
    const granted = await resolve(externalAuth(["web_search", "remember"]));
    expect(Object.keys(granted)).toEqual(expect.arrayContaining(["auto-analyst", "policy-finance-analyst"]));
    const revoked = await resolve(externalAuth(["remember"]));
    expect(Object.keys(revoked)).not.toContain("auto-analyst");
    expect(Object.keys(await resolve(externalAuth(["web_search"]), { subagent: true }))).not.toContain("auto-analyst");
  });
});
