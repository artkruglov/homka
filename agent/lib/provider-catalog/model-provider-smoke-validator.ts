/**
 * Configured language-model smoke validator.
 *
 * Exports:
 * - `ModelProviderSmokeOptions`: explicit config, credential, fetch, and timeout dependencies.
 * - `validateModelProviderSmoke`: verifies an exact tool call followed by exact final text.
 *
 * Key constructs:
 * - Real configured transport factory with injected fetch for testability.
 * - Retry-free two-step generate request with one bounded AbortSignal.
 * - Strict response oracle for tool name, input, execution result, steps, and final text.
 */
import type { FetchFunction } from "@ai-sdk/provider-utils";
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";

import { AppError } from "../app-error.js";
import type { ModelProviderConfig } from "../model-provider-config-schema.js";
import { createConfiguredLanguageModel } from "../model-transport.js";

const MAX_SMOKE_TIMEOUT_MS = 30_000;
const SMOKE_TOOL_NAME = "confirm_model_provider";
const SMOKE_TOOL_VALUE = "OSINARA_MODEL_PROVIDER_SMOKE_READY";
const SMOKE_FINAL_TEXT = "OSINARA_MODEL_PROVIDER_SMOKE_OK";
const SMOKE_PROMPT = [
  `Call ${SMOKE_TOOL_NAME} once with value ${SMOKE_TOOL_VALUE}.`,
  `After its result, answer exactly ${SMOKE_FINAL_TEXT}.`,
].join(" ");

export interface ModelProviderSmokeOptions {
  readonly apiKey: string;
  readonly config: ModelProviderConfig;
  readonly fetch: FetchFunction;
  readonly timeoutMs: number;
}

/** Runs the smallest deterministic agent loop that proves tool calling and continuation both work. */
export async function validateModelProviderSmoke(
  options: ModelProviderSmokeOptions,
): Promise<void> {
  if (
    !Number.isInteger(options.timeoutMs)
    || options.timeoutMs < 1
    || options.timeoutMs > MAX_SMOKE_TIMEOUT_MS
  ) {
    throw new AppError(
      "AGENT_PROVIDER_SMOKE_TIMEOUT_INVALID",
      `Таймаут проверки модели должен быть целым числом от 1 до ${MAX_SMOKE_TIMEOUT_MS} мс`,
    );
  }

  // The canonical config already carries the exact selected model and transport contract.
  const primary = options.config.agent.models.primary;
  const model = createConfiguredLanguageModel({
    apiKey: options.apiKey,
    fetch: options.fetch,
    maxOutputTokens: primary.maxOutputTokens,
    modelId: primary.id,
    transport: options.config.agent.transport,
  });
  const usesDeepSeekThinking = options.config.provider === "deepseek"
    && options.config.agent.transport.protocol === "openai-chat-completions"
    && options.config.agent.transport.reasoning?.type === "effort";
  const result = await generateText({
    abortSignal: AbortSignal.timeout(options.timeoutMs),
    maxRetries: 0,
    model,
    prepareStep: ({ stepNumber }) => usesDeepSeekThinking
      ? {}
      : {
          toolChoice: stepNumber === 0
            ? { toolName: SMOKE_TOOL_NAME, type: "tool" }
            : "none",
        },
    prompt: SMOKE_PROMPT,
    stopWhen: stepCountIs(2),
    tools: {
      [SMOKE_TOOL_NAME]: tool({
        execute: async ({ value }) => ({ accepted: value === SMOKE_TOOL_VALUE }),
        inputSchema: z.object({ value: z.literal(SMOKE_TOOL_VALUE) }).strict(),
      }),
    },
  });

  // A successful provider request is insufficient: enforce the complete semantic handshake.
  const firstStep = result.steps[0];
  const secondStep = result.steps[1];
  const exactToolCall = firstStep?.toolCalls.length === 1
    && firstStep.toolCalls[0]?.toolName === SMOKE_TOOL_NAME
    && JSON.stringify(firstStep.toolCalls[0].input) === JSON.stringify({ value: SMOKE_TOOL_VALUE });
  const exactToolResult = firstStep?.toolResults.length === 1
    && firstStep.toolResults[0]?.toolName === SMOKE_TOOL_NAME
    && JSON.stringify(firstStep.toolResults[0].output) === JSON.stringify({ accepted: true });
  const exactFinalStep = result.steps.length === 2
    && secondStep?.toolCalls.length === 0
    && result.text === SMOKE_FINAL_TEXT;
  if (!exactToolCall || !exactToolResult || !exactFinalStep) {
    throw new AppError(
      "AGENT_PROVIDER_SMOKE_RESPONSE_INVALID",
      "Модель не выполнила обязательную двухшаговую проверку инструментов",
    );
  }
}
