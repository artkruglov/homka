/**
 * Live-authorized Eve `load_skill` wrapper for external Telegram groups.
 *
 * Exports:
 * - `createExternalGroupLoadSkillTool`: injectable Eve-branded wrapper for authorization tests.
 * - `externalGroupLoadSkillTool`: production `defineTool` wrapper over Eve's native skill loader.
 * - Knowledge skills (`auto-analyst`, `policy-finance-analyst`) open with the live `web_search` grant.
 * - An authored skill opens only with a live grant to this group and every step tool in the live
 *   allowlist; a capability revoked after the grant closes the skill on the next call.
 */
import { defineTool, type ToolContext, type ToolDefinition } from "eve/tools";
import { loadSkill } from "eve/tools/defaults";

import { AppError } from "../app-error.js";
import { authoredSkillGrantRepository } from "../authored-skills/authored-skill-grant-repository.js";
import {
  AUTHORED_SKILL_NAME_PATTERN,
  externalGroupMissingTools,
  isReservedSkillName,
} from "../authored-skills/authored-skill-contract.js";
import { IMAGE_GENERATION_AVAILABLE } from "../image-generation/image-generation-availability.js";
import { isImageGenerationSkillName } from "../image-generation/image-generation-skill.js";
import { KNOWLEDGE_SKILL_CAPABILITY, isKnowledgeSkillName } from "./knowledge-skills.js";
import {
  authorizeCurrentExternalGroupCapability,
  loadCurrentExternalGroupCapabilities,
} from "../tool-policy/external-group-live-policy.js";
import { resolveExternalGroupPolicyIdentity } from "../tool-policy/external-group-policy.js";

type AnyToolDefinition = ToolDefinition<any, any>;

interface ExternalGroupLoadSkillDependencies {
  /** Throws unless the named authored skill is granted to this group and its steps are covered live. */
  authorizeAuthoredSkill(ctx: ToolContext, skill: string): Promise<void>;
  authorizeImageGeneration(ctx: ToolContext): Promise<void>;
  authorizeKnowledgeSkills(ctx: ToolContext): Promise<void>;
  executeNative(input: unknown, ctx: ToolContext): Promise<unknown>;
}

function forbidden(): AppError {
  return new AppError(
    "AGENT_GROUP_SKILL_FORBIDDEN",
    "Этот skill не разрешён в текущей группе. Обратитесь к владельцу агента",
  );
}

export function createExternalGroupLoadSkillTool(
  dependencies: ExternalGroupLoadSkillDependencies,
): AnyToolDefinition {
  return defineTool({
    ...(loadSkill as AnyToolDefinition),
    async execute(input, ctx) {
      const skill = (input as { skill?: unknown } | null)?.skill;
      if (typeof skill !== "string") throw forbidden();
      // An analyst skill adds method and references, never rights; the group's research grant
      // is re-read live so a revoked `web_search` closes the skill on the next call.
      if (isKnowledgeSkillName(skill)) {
        await dependencies.authorizeKnowledgeSkills(ctx);
        return await dependencies.executeNative(input, ctx);
      }
      // Image instructions are coupled to the tool grant, so the owner changes only one policy.
      // A grant persisted under a previous model provider must not resurrect the skill, so the
      // provider gate is re-checked here rather than trusting the turn-scoped skill manifest.
      if (isImageGenerationSkillName(skill)) {
        if (!IMAGE_GENERATION_AVAILABLE) throw forbidden();
        await dependencies.authorizeImageGeneration(ctx);
        return await dependencies.executeNative(input, ctx);
      }
      // Anything else can only be an authored skill the owner granted to this very group.
      if (!AUTHORED_SKILL_NAME_PATTERN.test(skill) || isReservedSkillName(skill)) throw forbidden();
      await dependencies.authorizeAuthoredSkill(ctx, skill);
      return await dependencies.executeNative(input, ctx);
    },
  });
}

const nativeLoadSkill = loadSkill as AnyToolDefinition;
export const externalGroupLoadSkillTool = createExternalGroupLoadSkillTool({
  authorizeAuthoredSkill: async (ctx, skill) => {
    const identity = resolveExternalGroupPolicyIdentity(ctx.session.auth);
    if (!identity) throw forbidden();
    const markdown = await authoredSkillGrantRepository.grantedMarkdown({ ...identity, name: skill });
    if (markdown === null) throw forbidden();
    const allowed = await loadCurrentExternalGroupCapabilities(identity);
    if (externalGroupMissingTools(markdown, allowed).length > 0) throw forbidden();
  },
  authorizeImageGeneration: async (ctx) => {
    const identity = resolveExternalGroupPolicyIdentity(ctx.session.auth);
    if (!identity) throw forbidden();
    await authorizeCurrentExternalGroupCapability(identity, "generate_image");
  },
  authorizeKnowledgeSkills: async (ctx) => {
    const identity = resolveExternalGroupPolicyIdentity(ctx.session.auth);
    if (!identity) throw forbidden();
    await authorizeCurrentExternalGroupCapability(identity, KNOWLEDGE_SKILL_CAPABILITY);
  },
  executeNative: (input, ctx) => nativeLoadSkill.execute(input, ctx),
});
