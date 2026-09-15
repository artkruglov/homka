/**
 * Common model-facing execution boundary for Eve tools.
 *
 * Exports:
 * - `wrapModelFacingTool`: preserves a descriptor while normalizing every thrown error and telling
 *   the model when its pre-tool text has already been delivered.
 * - `wrapModelFacingToolMap`: applies the boundary once to a complete mode-scoped surface.
 */
import { defineTool, type ToolDefinition } from "eve/tools";

import { requireToolSpaceAccess } from "./sessions/session-tool-space-access.js";

import { isAppError } from "./app-error.js";
import { ModelFacingError, normalizeModelFacingError } from "./model-facing-error.js";
import {
  PROGRESS_NOTICE_SENT_NOTE,
  progressNoticeKey,
  telegramProgressNoticeDeferral,
} from "./telegram-progress-deferral.js";
import {
  TOOL_REPEAT_WITHOUT_PROGRESS_CODE,
  toolCallFingerprint,
  toolRepeatGuard,
} from "./tool-repeat-guard.js";

type AnyToolDefinition = ToolDefinition<any, any>;
type ApprovalPolicyFunction = (ctx: unknown) => unknown;

function turnKey(ctx: unknown): string | null {
  const session = (ctx as { session?: { id?: unknown; turn?: { id?: unknown } } } | undefined)
    ?.session;
  if (typeof session?.id !== "string" || typeof session.turn?.id !== "string") return null;
  return `${session.id}:${session.turn.id}`;
}

function repeatWithoutProgressError(toolName: string): ModelFacingError {
  return new ModelFacingError({
    category: "operation",
    code: TOOL_REPEAT_WITHOUT_PROGRESS_CODE,
    correction:
      `Этот вызов ${toolName} с теми же аргументами уже завершился ошибкой в этом ходе. ` +
      "Не повторяйте его без изменений: измените аргументы или подход, либо сообщите пользователю, что не удалось, и дождитесь нового запроса.",
    reason: "Повтор вызова с теми же аргументами после ошибки не даёт нового результата.",
    retryable: false,
    sideEffectStatus: "not_started",
  });
}

/**
 * Eve treats an exception thrown by an approval policy as a failed model call and parks the whole
 * session for a manual retry. Input validation inside a policy is an ordinary correctable error,
 * so it becomes a denial with the reason the model can act on.
 */
function wrapApprovalPolicy(approval: unknown): unknown {
  if (typeof approval !== "function") return approval;
  const policy = approval as ApprovalPolicyFunction;
  return async (ctx: unknown) => {
    try {
      return await policy(ctx);
    } catch (error) {
      if (isAppError(error)) return { reason: error.message, type: "denied" };
      throw error;
    }
  };
}

// Generic call discipline lives once in `agent/instructions.md`; repeating it in every descriptor
// added roughly 17k characters to each model call without adding information.
export function wrapModelFacingTool(
  toolName: string,
  definition: AnyToolDefinition,
): AnyToolDefinition {
  return defineTool({
    ...definition,
    ...(definition.approval === undefined
      ? {}
      : { approval: wrapApprovalPolicy(definition.approval) as AnyToolDefinition["approval"] }),
    async execute(input, ctx) {
      const turn = turnKey(ctx);
      const fingerprint = turn === null ? null : toolCallFingerprint(toolName, input);
      if (turn !== null && fingerprint !== null && toolRepeatGuard.refuses(turn, fingerprint)) {
        throw repeatWithoutProgressError(toolName);
      }
      let output: unknown;
      try {
        await requireToolSpaceAccess(ctx);
        output = await definition.execute(input, ctx);
      } catch (error) {
        if (turn !== null && fingerprint !== null) toolRepeatGuard.recordFailure(turn, fingerprint);
        throw normalizeModelFacingError(error, { toolName });
      }
      if (turn !== null && fingerprint !== null) toolRepeatGuard.recordSuccess(turn, fingerprint);
      return withDeliveredNoticeNote(output, ctx);
    },
  });
}

/**
 * The model writes its final message right after this result. Without the note it answers every
 * topic again, and the person reads the pre-tool text twice.
 */
function withDeliveredNoticeNote(output: unknown, ctx: unknown): unknown {
  if (output === null || typeof output !== "object" || Array.isArray(output)) return output;
  const session = (ctx as { session?: { id?: unknown; turn?: { id?: unknown } } } | undefined)
    ?.session;
  if (typeof session?.id !== "string" || typeof session.turn?.id !== "string") return output;
  if (!telegramProgressNoticeDeferral.wasSent(progressNoticeKey(session.id, session.turn.id))) {
    return output;
  }
  return { ...output, already_sent_to_user: PROGRESS_NOTICE_SENT_NOTE };
}

export function wrapModelFacingToolMap<T extends Readonly<Record<string, AnyToolDefinition>>>(
  surface: T,
): T {
  return Object.fromEntries(
    Object.entries(surface).map(([name, definition]) => [
      name,
      wrapModelFacingTool(name, definition),
    ]),
  ) as T;
}
