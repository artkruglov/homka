/**
 * Turn-scoped Eve skill map for the family's authored skills.
 *
 * Export:
 * - `resolveAuthoredTurnSkills`: the owner's private chat, the family group and their scheduled
 *   runs receive every active authored skill; external groups, silent review and subagents none.
 *
 * Key construct:
 * - Resolution happens on every `turn.started` because Eve rebuilds the manifest per event and
 *   canonical sessions live for days; a published skill is loadable from the next turn.
 */
import type { SessionAuth } from "eve/context";
import { defineSkill, type SkillDefinition } from "eve/skills";

import { resolveConversationEnvironment } from "../conversation-environment.js";
import { authoredSkillRepository, type AuthoredSkillPackage } from "./authored-skill-repository.js";

export interface AuthoredSkillResolverOptions {
  memoryReview?: boolean;
  subagent?: boolean;
}

interface AuthoredSkillResolverDependencies {
  activePackages(familyId: string): Promise<readonly AuthoredSkillPackage[]>;
}

function packageDefinition(pkg: AuthoredSkillPackage): SkillDefinition {
  return defineSkill({
    description: pkg.description,
    markdown: pkg.markdown,
    ...(Object.keys(pkg.files).length === 0 ? {} : { files: pkg.files }),
  });
}

export function createAuthoredTurnSkillResolver(dependencies: AuthoredSkillResolverDependencies) {
  return async function resolveAuthoredTurnSkills(
    auth: SessionAuth,
    options: AuthoredSkillResolverOptions = {},
  ): Promise<Record<string, SkillDefinition>> {
    if (options.memoryReview === true || options.subagent === true) return {};
    const environment = resolveConversationEnvironment(auth);
    if (environment === "external") return {};
    const attributes = auth.current?.attributes;
    const familyId = attributes?.familyId;
    if (typeof familyId !== "string") return {};
    // The private chat of a non-owner family member is trusted but not part of the library.
    if (environment === "private" && attributes?.role !== "owner") return {};
    const packages = await dependencies.activePackages(familyId);
    return Object.fromEntries(packages.map((pkg) => [pkg.name, packageDefinition(pkg)]));
  };
}

export const resolveAuthoredTurnSkills = createAuthoredTurnSkillResolver({
  activePackages: (familyId) => authoredSkillRepository.activePackages(familyId),
});
