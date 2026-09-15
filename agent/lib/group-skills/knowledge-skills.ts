/**
 * Static knowledge skills admitted into external groups.
 *
 * Exports:
 * - `KNOWLEDGE_SKILL_NAMES`: analyst skills that add method and reference material, not rights.
 * - `KNOWLEDGE_SKILL_CAPABILITY`: the granted tool that makes them useful and gates them.
 * - `isKnowledgeSkillName`: exact-name check used by the external `load_skill` wrapper.
 *
 * Key constructs:
 * - A knowledge skill calls nothing beyond `web_search` and `web_fetch`; granting `web_search`
 *   is the owner's decision that the group may research, so the same grant opens the skills.
 */
import type { ExternalGroupToolName } from "../tool-policy/group-tool-catalog.js";

export const KNOWLEDGE_SKILL_NAMES = ["auto-analyst", "policy-finance-analyst"] as const;
export type KnowledgeSkillName = (typeof KNOWLEDGE_SKILL_NAMES)[number];

export const KNOWLEDGE_SKILL_CAPABILITY: ExternalGroupToolName = "web_search";

export function isKnowledgeSkillName(value: string): value is KnowledgeSkillName {
  return (KNOWLEDGE_SKILL_NAMES as readonly string[]).includes(value);
}
