/**
 * Turn-scoped prompt block resolution.
 *
 * Exports:
 * - `TurnBlockContext`: the minimal Eve resolve context a block resolver reads.
 * - `createModeBlockResolver` / `resolveModeBlock`: verified mode rulebook for the current turn.
 * - `createPreferenceBlockResolver` / `resolvePreferenceBlock`: one editable chat prompt.
 *
 * Key constructs:
 * - Eve keeps a previous turn's block when a dynamic resolver throws, and never clears the durable
 *   record on its own. Every resolver here therefore returns an explicit value instead of throwing:
 *   a fail-closed block where the model must stop, and `null` where an absent block is safe.
 */
import type { SessionAuth } from "eve/context";
import type { ModelMessage } from "ai";

import { authoredSkillGrantRepository } from "../authored-skills/authored-skill-grant-repository.js";
import {
  requireBehaviorPreferenceReadAuthorization,
  type BehaviorPreferenceReadAuthorization,
} from "../behavior-preference-context.js";
import {
  buildBehaviorPreferenceInstructions,
  type ChatOperationalPrompt,
} from "../behavior-preferences.js";
import { behaviorPreferenceRepository } from "../behavior-preference-repository.js";
import { resolveConversationEnvironment } from "../conversation-environment.js";
import { isTelegramChannelSession } from "../telegram-session-actor.js";
import {
  TELEGRAM_REACTION_POLICY_TTL_MILLISECONDS,
  type TelegramReactionPolicy,
} from "../telegram-reaction-policy.js";
import { telegramReactionPolicyRepository } from "../telegram-reaction-policy-repository.js";
import { loadCurrentExternalGroupCapabilities } from "../tool-policy/external-group-live-policy.js";
import type { ExternalGroupToolName } from "../tool-policy/group-tool-catalog.js";
import {
  resolveExternalGroupPolicyIdentity,
  resolveExternalGroupToolPolicy,
} from "../tool-policy/external-group-policy.js";
import { scheduledGroupHistoryAccess } from "../agent-schedules/scheduled-group-history-context.js";
import { isScheduledSession } from "../agent-schedules/scheduled-session.js";
import { modeInstructions } from "./mode-instructions.js";

export interface TurnBlockContext {
  readonly channel?: { readonly kind?: string };
  readonly messages: readonly ModelMessage[];
  readonly session: {
    readonly auth: SessionAuth;
    readonly id: string;
  };
}

type CapabilityLoader = (identity: {
  familyId: string;
  groupId: string;
}) => Promise<ReadonlySet<ExternalGroupToolName>>;
type ReactionPolicyLoader = (telegramChatId: string) => Promise<TelegramReactionPolicy | null>;
type GrantedSkillLoader = (identity: {
  familyId: string;
  groupId: string;
}) => Promise<readonly { description: string; name: string }[]>;

interface EffectiveExternalCapabilities {
  authoredSkills: readonly { description: string; name: string }[];
  capabilities: ReadonlySet<ExternalGroupToolName>;
  includeApplicationCore: boolean;
}

const MODE_UNAVAILABLE_BLOCK = `
<current_conversation_environment>
# Режим текущего чата не определён

Возможности этого чата подтвердить не удалось (AGENT_CONVERSATION_ENVIRONMENT_INVALID). Не используй память, workspace, учётные данные, инструменты и интеграции и не выполняй никаких действий.

Ответь пользователю одним коротким человеческим сообщением: не получилось определить режим этого чата, попроси отправить сообщение ещё раз. Код ошибки не называй. Затем остановись.
</current_conversation_environment>
`.trim();

function logBlockFailure(code: string, error: unknown): void {
  // Prompt assembly must not fail the turn, so the cause stays in logs with a stable code.
  console.error(JSON.stringify({
    code,
    error: error instanceof Error ? error.message : String(error),
  }));
}

async function effectiveExternalCapabilities(
  auth: SessionAuth,
  loadCapabilities: CapabilityLoader,
  loadGrantedSkills: GrantedSkillLoader | undefined,
  scheduledRun: boolean,
): Promise<EffectiveExternalCapabilities> {
  const none: EffectiveExternalCapabilities = { authoredSkills: [], capabilities: new Set(), includeApplicationCore: false };
  const policy = resolveExternalGroupToolPolicy(auth);
  if (!policy.restricted) return none;
  const identity = resolveExternalGroupPolicyIdentity(auth);
  if (!identity) return none;

  // An unavailable policy lookup must describe no capability at all, matching the fail-closed
  // execution boundary, instead of leaving the previous turn's wider guidance in place.
  let current: ReadonlySet<ExternalGroupToolName>;
  try {
    current = await loadCapabilities(identity);
  } catch (error) {
    logBlockFailure("AGENT_GROUP_CAPABILITY_LOOKUP_FAILED", error);
    return none;
  }
  // Granted authored skills are described only when the resolver would also emit them; a failed
  // lookup leaves them out of the prompt the same way it leaves them out of the manifest.
  let authoredSkills: readonly { description: string; name: string }[] = [];
  if (loadGrantedSkills !== undefined && !scheduledRun) {
    try {
      authoredSkills = await loadGrantedSkills(identity);
    } catch (error) {
      logBlockFailure("AGENT_SKILL_GRANT_LOOKUP_FAILED", error);
    }
  }
  return {
    authoredSkills,
    capabilities: new Set([...policy.allowed].filter((capability) => current.has(capability))),
    includeApplicationCore: true,
  };
}

function verifiedTelegramChatId(auth: SessionAuth): string | null {
  const chatId = auth.current?.attributes.telegramChatId;
  return typeof chatId === "string" && chatId.length > 0 ? chatId : null;
}

export function createModeBlockResolver(dependencies: {
  loadCapabilities: CapabilityLoader;
  loadGrantedSkills?: GrantedSkillLoader;
  loadReactionPolicy: ReactionPolicyLoader;
}) {
  return async function resolve(ctx: TurnBlockContext): Promise<string> {
    let environment: ReturnType<typeof resolveConversationEnvironment>;
    try {
      environment = resolveConversationEnvironment(ctx.session.auth);
    } catch (error) {
      logBlockFailure("AGENT_CONVERSATION_ENVIRONMENT_INVALID", error);
      return MODE_UNAVAILABLE_BLOCK;
    }
    const scheduledRun = isScheduledSession(ctx);
    // A scheduled run has no inbound message to react to, and a channel-authored turn keeps its
    // text-only surface, so neither one requests a reaction policy.
    const reactionsPossible = !scheduledRun && !isTelegramChannelSession(ctx.session.auth);
    let reactionPolicy: TelegramReactionPolicy | null = null;
    const telegramChatId = reactionsPossible ? verifiedTelegramChatId(ctx.session.auth) : null;
    if (telegramChatId !== null) {
      try {
        reactionPolicy = await dependencies.loadReactionPolicy(telegramChatId);
      } catch (error) {
        logBlockFailure("AGENT_TELEGRAM_REACTION_POLICY_LOOKUP_FAILED", error);
      }
    }
    if (environment !== "external") {
      // Блок режима обязан называть ровно тот набор корней, который ход получит: после включения
      // областей личный чат монтирует только свой, и обещание семейного стало бы приглашением
      // искать файлы там, где их для этого хода нет.
      const attributes = ctx.session.auth.current?.attributes;
      const singleArea = attributes?.spaceId !== undefined;
      // Название приходит из той же проверенной подготовки хода, что и сама область.
      const activeArea = typeof attributes?.spaceTitle === "string" ? attributes.spaceTitle : undefined;
      return modeInstructions({ activeArea, environment, reactionPolicy, scheduledRun, singleArea });
    }

    // Channel-authored turns can receive text only. Keep prompt instructions aligned with the
    // descriptor-absent execution surface without consulting grants owned by human participants.
    if (isTelegramChannelSession(ctx.session.auth)) {
      return modeInstructions({
        capabilities: new Set(),
        environment: "external",
        includeApplicationCore: false,
        reactionPolicy,
        scheduledRun,
      });
    }

    const effective = await effectiveExternalCapabilities(
      ctx.session.auth,
      dependencies.loadCapabilities,
      dependencies.loadGrantedSkills,
      scheduledRun,
    );
    return modeInstructions({
      authoredSkills: effective.authoredSkills,
      capabilities: effective.capabilities,
      environment: "external",
      includeApplicationCore: effective.includeApplicationCore,
      reactionPolicy,
      scheduledHistory: effective.includeApplicationCore &&
        scheduledGroupHistoryAccess(ctx.session.auth) !== null,
      scheduledRun,
    });
  };
}

export function createPreferenceBlockResolver(dependencies: {
  authorize: (ctx: TurnBlockContext) => BehaviorPreferenceReadAuthorization;
  get: (auth: BehaviorPreferenceReadAuthorization) => Promise<ChatOperationalPrompt>;
}) {
  return async function resolve(ctx: TurnBlockContext): Promise<string | null> {
    try {
      const authorization = dependencies.authorize(ctx);
      return buildBehaviorPreferenceInstructions(await dependencies.get(authorization));
    } catch (error) {
      // The editable prompt only shapes presentation, so an absent block is safe on failure.
      logBlockFailure("AGENT_BEHAVIOR_PREFERENCE_UNAVAILABLE", error);
      return null;
    }
  };
}

export const resolveModeBlock = createModeBlockResolver({
  loadCapabilities: loadCurrentExternalGroupCapabilities,
  loadGrantedSkills: async (identity) => (await authoredSkillGrantRepository.packagesForGroup(identity))
    .map((pkg) => ({ description: pkg.description, name: pkg.name })),
  loadReactionPolicy: async (telegramChatId) => {
    const cached = await telegramReactionPolicyRepository.read(telegramChatId);
    if (cached === null) return null;
    // Past the refresh window the record proves only that getChat keeps failing, so the prompt
    // must not describe a reaction set an administrator may have already changed.
    const age = Date.now() - cached.fetchedAt.getTime();
    if (age >= TELEGRAM_REACTION_POLICY_TTL_MILLISECONDS) return null;
    return { allowsAll: cached.allowsAll, emoji: cached.emoji };
  },
});

export const resolvePreferenceBlock = createPreferenceBlockResolver({
  authorize: requireBehaviorPreferenceReadAuthorization,
  get: behaviorPreferenceRepository.get,
});
