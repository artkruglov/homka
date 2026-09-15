/**
 * Fail-closed per-turn model step enforcement.
 *
 * Exports:
 * - `resolveTurnModelStepLimitSelection`: returns a blocking model at or beyond the limit.
 *
 * Key constructs:
 * - Strict `step.started` validation prevents malformed runtime state from bypassing the guard.
 * - The blocking model rejects both AI SDK call paths without invoking the upstream provider.
 */
import type { LanguageModelV4 } from "@ai-sdk/provider";

import { AppError } from "./app-error.js";

interface TurnModelStepLimitInput {
  readonly event: unknown;
  readonly maxModelSteps: number;
  readonly model: LanguageModelV4;
  readonly modelContextWindowTokens: number;
}

interface TurnModelStepLimitSelection {
  readonly model: LanguageModelV4;
  // Eve refuses a dynamic selection of an unlisted model without its window: the blocking model
  // then died as `DynamicModelSelectionError` and the whole session failed instead of the turn.
  readonly modelContextWindowTokens: number;
}

type BlockReason = "limit" | "state";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readStepIndex(event: unknown): number | null {
  if (!isRecord(event) || event.type !== "step.started" || !isRecord(event.data)) return null;
  const stepIndex = event.data.stepIndex;
  return typeof stepIndex === "number" && Number.isSafeInteger(stepIndex) && stepIndex >= 0
    ? stepIndex
    : null;
}

function modelStepError(reason: BlockReason): AppError {
  if (reason === "limit") {
    return new AppError(
      "AGENT_TURN_MODEL_STEP_LIMIT_EXCEEDED",
      "Агент остановил выполнение, потому что запрос потребовал слишком много шагов. Разбейте задачу на части и повторите",
    );
  }
  return new AppError(
    "AGENT_TURN_MODEL_STEP_STATE_INVALID",
    "Агент остановил выполнение из-за некорректного состояния шага. Повторите запрос",
  );
}

function createBlockingModel(model: LanguageModelV4, reason: BlockReason): LanguageModelV4 {
  // A valid model object prevents Eve's dynamic resolver from degrading to its fallback model.
  return {
    async doGenerate() {
      throw modelStepError(reason);
    },
    async doStream() {
      throw modelStepError(reason);
    },
    modelId: model.modelId,
    provider: model.provider,
    specificationVersion: "v4",
    supportedUrls: model.supportedUrls,
  };
}

export function resolveTurnModelStepLimitSelection({
  event,
  maxModelSteps,
  model,
  modelContextWindowTokens,
}: TurnModelStepLimitInput): TurnModelStepLimitSelection | null {
  const stepIndex = readStepIndex(event);
  const validLimit = Number.isSafeInteger(maxModelSteps) && maxModelSteps > 0;

  // Invalid runtime coordinates must never disable a production safety boundary.
  if (stepIndex === null || !validLimit) {
    return { model: createBlockingModel(model, "state"), modelContextWindowTokens };
  }
  if (stepIndex < maxModelSteps) return null;
  return { model: createBlockingModel(model, "limit"), modelContextWindowTokens };
}
