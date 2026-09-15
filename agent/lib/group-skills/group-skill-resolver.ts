/**
 * Lifecycle-scoped Eve skill visibility resolvers.
 *
 * Exports:
 * - `resolveTrustedSessionSkills`: stable private/family packages materialized once per session.
 * - `resolveExternalTurnSkills`: external capability-coupled packages plus the authored skills the
 *   owner granted to this group, refreshed per turn.
 * - `createExternalTurnSkillResolver`: the same with an injectable grant source for tests.
 */
import type { SessionAuth } from "eve/context";
import { defineSkill, type SkillDefinition } from "eve/skills";

import { authoredSkillGrantRepository } from "../authored-skills/authored-skill-grant-repository.js";
import type { AuthoredSkillPackage } from "../authored-skills/authored-skill-repository.js";
import { resolveConversationEnvironment } from "../conversation-environment.js";
import { GOOGLE_WORKSPACE_AVAILABLE } from "../google-workspace/google-workspace-availability.js";
import { IMAGE_GENERATION_AVAILABLE } from "../image-generation/image-generation-availability.js";
import {
  IMAGE_GENERATION_SKILL_DEFINITION,
  IMAGE_GENERATION_SKILL_NAME,
} from "../image-generation/image-generation-skill.js";
import {
  resolveExternalGroupPolicyIdentity,
  resolveExternalGroupToolPolicy,
} from "../tool-policy/external-group-policy.js";
import { TRUSTED_GOOGLE_WORKSPACE_SKILL_DEFINITIONS } from "./trusted-google-workspace-skills.js";
import { knowledgeSkills } from "./knowledge-skill-packages.js";
import { KNOWLEDGE_SKILL_CAPABILITY } from "./knowledge-skills.js";

interface ConversationSkillResolverOptions {
  scheduledRun?: boolean;
  subagent?: boolean;
}

function imageGenerationSkill(
  options: ConversationSkillResolverOptions,
  scheduledAllowed = false,
): Record<string, SkillDefinition> {
  // A trusted scheduled run (a morning greeting card) may generate; an external one still may not.
  return IMAGE_GENERATION_AVAILABLE &&
      (scheduledAllowed || options.scheduledRun !== true) && options.subagent !== true
    ? { [IMAGE_GENERATION_SKILL_NAME]: IMAGE_GENERATION_SKILL_DEFINITION }
    : {};
}

export function resolveTrustedSessionSkills(
  auth: SessionAuth,
  options: ConversationSkillResolverOptions = {},
): Record<string, SkillDefinition> {
  const environment = resolveConversationEnvironment(auth);
  if (environment === "external") return {};
  return {
    ...imageGenerationSkill(options, true),
    // Nineteen packages are uploaded into the sandbox per session; skip them when nobody can
    // connect a Google account anyway.
    ...(GOOGLE_WORKSPACE_AVAILABLE ? TRUSTED_GOOGLE_WORKSPACE_SKILL_DEFINITIONS : {}),
  };
}

interface ExternalTurnSkillDependencies {
  /** Authored skills granted to the group whose steps its current allowlist covers. */
  packagesForGroup(identity: { familyId: string; groupId: string }): Promise<readonly AuthoredSkillPackage[]>;
}

function packageDefinition(pkg: AuthoredSkillPackage): SkillDefinition {
  return defineSkill({
    description: pkg.description,
    markdown: pkg.markdown,
    ...(Object.keys(pkg.files).length === 0 ? {} : { files: pkg.files }),
  });
}

export function createExternalTurnSkillResolver(dependencies: ExternalTurnSkillDependencies) {
  return async function resolveExternalTurnSkills(
    auth: SessionAuth,
    options: ConversationSkillResolverOptions = {},
  ): Promise<Record<string, SkillDefinition>> {
    if (resolveConversationEnvironment(auth) !== "external") return {};
    const tools = resolveExternalGroupToolPolicy(auth);
    if (!tools.restricted) return {};
    const skills: Record<string, SkillDefinition> = tools.allowed.has("generate_image")
      ? imageGenerationSkill(options)
      : {};
    // Granted authored skills follow the group's grants, not a scheduled prompt or a child agent.
    if (options.scheduledRun === true || options.subagent === true) return skills;
    // Analyst skills ride on the research grant; the load_skill wrapper re-checks it live. Eve's
    // public load_skill executor knows only dynamic packages, so they must reach the sandbox here.
    if (tools.allowed.has(KNOWLEDGE_SKILL_CAPABILITY)) Object.assign(skills, knowledgeSkills());
    const identity = resolveExternalGroupPolicyIdentity(auth);
    if (!identity) return skills;
    let packages: readonly AuthoredSkillPackage[];
    try {
      packages = await dependencies.packagesForGroup(identity);
    } catch (error) {
      // A lookup failure leaves the group without authored skills for this turn; nothing widens.
      console.error(JSON.stringify({
        code: "AGENT_SKILL_GRANT_LOOKUP_FAILED",
        error: error instanceof Error ? error.message : String(error),
      }));
      return skills;
    }
    for (const pkg of packages) {
      // A static name can never be shadowed by a grant; the rubric already refuses such names.
      if (pkg.name in skills) continue;
      skills[pkg.name] = packageDefinition(pkg);
    }
    return skills;
  };
}

export const resolveExternalTurnSkills = createExternalTurnSkillResolver({
  packagesForGroup: (identity) => authoredSkillGrantRepository.packagesForGroup(identity),
});
