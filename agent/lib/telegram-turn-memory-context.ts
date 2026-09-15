/**
 * Retrieved memory as Telegram delivery context.
 *
 * Exports:
 * - `TelegramMemoryContextInput`: verified facts of one accepted turn the builder may use.
 * - `createTelegramMemoryContextBuilder`: injectable builder returning context blocks.
 * - `buildTelegramMemoryContext`: production builder.
 *
 * Key constructs:
 * - Eve turns every delivery context string into a user message placed right before the current
 *   message, inside history. The system prefix and the tool descriptors therefore stay
 *   byte-identical between turns and the provider prompt cache covers them; a system-role memory
 *   block changed every turn and cut the cache at that point.
 * - Authorization derives from verified conversation access and the verified actor only.
 * - The same-turn profile view binds to the application session and the timeline entry, which
 *   exist before Eve starts the turn; Eve turn identity is not known at this boundary.
 * - Any failure degrades to an explicit unavailability notice: prompt assembly never fails a turn.
 */
import type { ConversationAccess } from "./family-access.js";
import type { MemoryAuthorization } from "./memory-context.js";
import { memoryContextExposureRepository } from "./memory-context-exposure-repository.js";
import {
  formatRetrievedMemoryInstructions,
  MEMORY_FRESHNESS_REMINDER,
  MEMORY_USED_REMINDER,
  retrieveMemoryTurnContext,
  type MemoryTurnContext,
  type MemoryTurnContextOptions,
} from "./memory-retrieval.js";
import { formatSkillHint, skillHintRepository, type SkillHint } from "./authored-skills/skill-hint-repository.js";
import { formatProfileViewContext, profileViewRepository } from "./profile-view-repository.js";
import type { CreateProfileViewInput, ProfileView } from "./profile-view.js";
import type { TelegramActorKind } from "./telegram-inbound-actor.js";

export interface TelegramMemoryContextInput {
  readonly access: ConversationAccess;
  readonly actor: { readonly id: string; readonly kind: TelegramActorKind };
  readonly applicationSessionId: string;
  /** Область, доказанная подготовкой сессии; отсутствует, пока режим семьи прежний. */
  readonly space?: { readonly policyVersion: number; readonly spaceId: string };
  readonly conversationId: string;
  readonly explicitMentionTelegramUserIds: readonly string[];
  readonly query: string;
  readonly replyTelegramUserId: string | null;
  readonly replyTimelineSequence: string | null;
  readonly timelineEntryId: string;
  readonly turnStartedAt: Date;
  /** Provider search exists in this chat: always in trusted chats, in an external group by grant. */
  readonly webSearchAvailable: boolean;
}

interface ExposureLedger {
  authorCardShownRecently(applicationSessionId: string, telegramUserId: string, sessionTurn: number): Promise<boolean>;
  recentlyShownMemoryRefs(applicationSessionId: string, sessionTurn: number): Promise<Set<string>>;
  record(input: {
    applicationSessionId: string;
    authorTelegramUserId: string | null;
    memoryRefs: readonly string[];
    sessionTurn: number;
  }): Promise<void>;
  sessionTurn(applicationSessionId: string): Promise<number>;
}

interface TelegramMemoryContextDependencies {
  createProfile(auth: MemoryAuthorization, input: CreateProfileViewInput): Promise<ProfileView | null>;
  /** What this session already showed; absent in tests that do not care about repetition. */
  exposures?: ExposureLedger;
  /** Pending repeat-task hint for this conversation; consumed once shown. */
  takeSkillHint?(conversationId: string): Promise<SkillHint | null>;
  retrieve(
    auth: MemoryAuthorization,
    query: string,
    skillHints: readonly string[],
    options?: MemoryTurnContextOptions,
  ): Promise<MemoryTurnContext>;
}

const MEMORY_UNAVAILABLE_BLOCK = [
  "AGENT_MEMORY_UNAVAILABLE: В этом ходу долговременная память недоступна.",
  "Не утверждай, что проверила память, и не делай вывод, что записей нет.",
  "Если ответ зависит от долговременной памяти, скажи, что она временно недоступна, и предложи повторить запрос позже.",
].join(" ");

function memoryAuthorization(input: TelegramMemoryContextInput): MemoryAuthorization {
  return {
    ...(input.space === undefined ? {} : { space: input.space }),
    familyId: input.access.familyId,
    groupId: input.access.groupId,
    role: input.access.role,
    scopes: [...input.access.memoryScopes],
    telegramActorId: input.actor.id,
    telegramActorKind: input.actor.kind,
    telegramUserId: input.actor.kind === "telegram_user" ? input.actor.id : null,
    userId: input.access.userId,
  };
}

export function createTelegramMemoryContextBuilder(dependencies: TelegramMemoryContextDependencies) {
  return async function build(input: TelegramMemoryContextInput): Promise<string[]> {
    const query = input.query.trim();
    if (query.length === 0) return [];
    try {
      const authorization = memoryAuthorization(input);
      const startedAt = performance.now();
      // The same three facts shown fifty times a day read as a stuck record; what this session
      // already showed recently stays out of the automatic block (the model can still search).
      const exposures = dependencies.exposures;
      const sessionTurn = exposures ? await exposures.sessionTurn(input.applicationSessionId) : 0;
      const excludeMemoryRefs = exposures
        ? await exposures.recentlyShownMemoryRefs(input.applicationSessionId, sessionTurn)
        : new Set<string>();
      // Skill-derived thread hints came from load_skill calls in history; none are reviewed now.
      const context = await dependencies.retrieve(authorization, query, [], { excludeMemoryRefs });
      const retrievedAt = performance.now();
      const isUser = input.actor.kind === "telegram_user";
      const authorIsSubject = input.replyTelegramUserId === input.actor.id ||
        input.explicitMentionTelegramUserIds.includes(input.actor.id);
      const suppressCurrentAuthor = isUser && exposures !== undefined && !authorIsSubject &&
        await exposures.authorCardShownRecently(input.applicationSessionId, input.actor.id, sessionTurn);
      // A channel post has no human subject to build a profile for.
      const profile = isUser
        ? await dependencies.createProfile(authorization, {
          conversationId: input.conversationId,
          currentTelegramUserId: input.actor.id,
          explicitMentionTelegramUserIds: [...input.explicitMentionTelegramUserIds],
          now: input.turnStartedAt,
          provenance: { sessionId: input.applicationSessionId, turnId: input.timelineEntryId },
          replyTelegramUserId: input.replyTelegramUserId,
          ...(input.replyTimelineSequence === null
            ? {}
            : { replyTimelineSequence: input.replyTimelineSequence }),
          retrievalClaimIds: [...context.retrievedClaimIds],
          suppressCurrentAuthor,
        })
        : null;
      const shownMemoryRefs = [
        ...context.memories.flatMap((memory) => "memoryRef" in memory && typeof memory.memoryRef === "string" ? [memory.memoryRef] : []),
        ...(profile?.subjects.flatMap((subject) => subject.claims.map((claim) => claim.memoryRef)) ?? []),
      ];
      if (exposures) {
        const shownAuthorCard = profile?.subjects.some((subject) => subject.priority === "current_author") === true;
        await exposures.record({
          applicationSessionId: input.applicationSessionId,
          authorTelegramUserId: shownAuthorCard ? input.actor.id : null,
          memoryRefs: shownMemoryRefs,
          sessionTurn,
        });
      }
      // Per-turn cost of memory on a small server: retrieval (FTS + E5 + pgvector) and profile view.
      console.info(JSON.stringify({
        code: "AGENT_MEMORY_CONTEXT",
        memories: context.memories.length,
        profile: profile !== null,
        profileMs: Math.round(performance.now() - retrievedAt),
        retrievalMs: Math.round(retrievedAt - startedAt),
        threads: context.threads.threads.length,
      }));
      const hint = dependencies.takeSkillHint === undefined
        ? null
        : await dependencies.takeSkillHint(input.conversationId);
      return [
        ...(profile === null ? [] : [formatProfileViewContext(profile)]),
        // Reminders sit right after the records: the rules in the mode block alone were ignored.
        shownMemoryRefs.length === 0
          ? formatRetrievedMemoryInstructions(context.memories, context.threads)
          : [
            formatRetrievedMemoryInstructions(context.memories, context.threads),
            MEMORY_USED_REMINDER,
            ...(input.webSearchAvailable ? [MEMORY_FRESHNESS_REMINDER] : []),
          ].join("\n"),
        ...(hint === null ? [] : [formatSkillHint(hint)]),
      ];
    } catch (error) {
      console.error(JSON.stringify({
        code: "AGENT_MEMORY_UNAVAILABLE",
        error: error instanceof Error ? error.message : String(error),
      }));
      return [MEMORY_UNAVAILABLE_BLOCK];
    }
  };
}

export const buildTelegramMemoryContext = createTelegramMemoryContextBuilder({
  createProfile: profileViewRepository.create,
  exposures: memoryContextExposureRepository,
  retrieve: retrieveMemoryTurnContext,
  takeSkillHint: (conversationId) => skillHintRepository.take(conversationId),
});
