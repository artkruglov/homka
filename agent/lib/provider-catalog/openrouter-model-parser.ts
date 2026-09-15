/**
 * OpenRouter model catalog parser.
 *
 * Exports:
 * - `parseOpenRouterModels`: validates, filters, and normalizes OpenRouter model metadata.
 *
 * Key constructs:
 * - Strict schemas for capabilities, token limits, and reasoning metadata.
 * - Tool/text capability filter required by the provider installer.
 */
import { z } from "zod";

import { MODEL_PROVIDER_MAX_OUTPUT_TOKENS } from "../model-provider-limits.js";
import { providerCatalogError } from "./provider-catalog-errors.js";
import type {
  ProviderCatalogModel,
  ReasoningEffort,
  ReasoningSelection,
} from "./provider-catalog-types.js";

const reasoningOptionSchema = z.enum([
  "max",
  "xhigh",
  "high",
  "medium",
  "low",
  "minimal",
  "none",
]);
const positiveIntegerSchema = z.number().int().positive();
const supportedParametersSchema = z.array(z.string().trim().min(1));

const openRouterModelSchema = z.object({
  architecture: z.object({
    input_modalities: z.array(z.string().trim().min(1)),
    output_modalities: z.array(z.string().trim().min(1)),
  }).passthrough(),
  context_length: positiveIntegerSchema,
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  reasoning: z.object({
    default_effort: reasoningOptionSchema.nullable().optional(),
    default_enabled: z.boolean().optional(),
    mandatory: z.boolean(),
    supported_efforts: z.array(reasoningOptionSchema).nullable().optional(),
    supports_max_tokens: z.boolean().optional(),
  }).strict().optional(),
  supported_parameters: supportedParametersSchema,
  top_provider: z.object({
    is_moderated: z.boolean(),
    max_completion_tokens: positiveIntegerSchema.nullable().optional(),
  }).passthrough(),
}).passthrough();

const openRouterCatalogSchema = z.object({
  data: z.array(openRouterModelSchema),
}).passthrough();

type OpenRouterModel = z.infer<typeof openRouterModelSchema>;
type OpenRouterReasoningEffort = z.infer<typeof reasoningOptionSchema>;

/** OpenRouter currently exposes three request parameter names for reasoning controls. */
const REASONING_PARAMETERS = new Set([
  "reasoning",
  "reasoning_effort",
]);

const ALL_REASONING_EFFORTS: ReasoningEffort[] = [
  "max",
  "xhigh",
  "high",
  "medium",
  "low",
  "minimal",
];

/** Only actual request support permits exposing reasoning choices to installer clients. */
function supportsReasoningParameter(parameters: string[]): boolean {
  return parameters.some((parameter) => REASONING_PARAMETERS.has(parameter));
}

/** Removes duplicate efforts while preserving OpenRouter's documented descending order. */
function uniqueReasoningOptions(options: ReasoningSelection[]): ReasoningSelection[] {
  const seen = new Set<string>();
  return options.filter((option) => {
    const key = JSON.stringify(option);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Converts an OpenRouter effort literal into the installer-ready discriminated union. */
function reasoningSelection(effort: OpenRouterReasoningEffort): ReasoningSelection {
  return effort === "none" ? { type: "none" } : { effort, type: "effort" };
}

/** Builds options solely from reasoning metadata and supported request parameters. */
function normalizeReasoning(model: OpenRouterModel): Pick<
  ProviderCatalogModel,
  "defaultReasoningOption" | "reasoningOptions"
> | null {
  const reasoning = model.reasoning;
  if (!reasoning || !supportsReasoningParameter(model.supported_parameters)) {
    return { defaultReasoningOption: null, reasoningOptions: [] };
  }

  // Explicit null means no provider allowlist; an absent field provides no safe effort metadata.
  if (reasoning.supported_efforts === undefined) {
    return { defaultReasoningOption: null, reasoningOptions: [] };
  }
  const supportedEfforts = reasoning.supported_efforts ?? ALL_REASONING_EFFORTS;

  const allowedEfforts = reasoning.mandatory
    ? supportedEfforts.filter((effort) => effort !== "none")
    : [...new Set<OpenRouterReasoningEffort>(["none", ...supportedEfforts])];
  const defaultEffort = reasoning.default_effort
    ?? (reasoning.default_enabled === false && !reasoning.mandatory ? "none" : null);

  // Contradictory defaults make the provider response unsafe to expose as a selection contract.
  if (defaultEffort !== null && !allowedEfforts.includes(defaultEffort)) {
    return null;
  }

  return {
    defaultReasoningOption: defaultEffort === null ? null : reasoningSelection(defaultEffort),
    reasoningOptions: uniqueReasoningOptions(allowedEfforts.map(reasoningSelection)),
  };
}

/** Rejects malformed entries globally, then filters only well-formed but unsuitable models. */
export function parseOpenRouterModels(body: unknown): ProviderCatalogModel[] {
  const result = openRouterCatalogSchema.safeParse(body);
  if (!result.success) {
    throw providerCatalogError("response-invalid", "openrouter");
  }

  const normalizedModels: ProviderCatalogModel[] = [];
  for (const model of result.data.data) {
    const hasTextInput = model.architecture.input_modalities.includes("text");
    const supportsTools = model.supported_parameters.includes("tools");
    const maxOutputTokens = model.top_provider.max_completion_tokens;
    if (!hasTextInput || !supportsTools || maxOutputTokens === null
      || maxOutputTokens === undefined) {
      continue;
    }

    const reasoning = normalizeReasoning(model);
    if (!reasoning) {
      throw providerCatalogError("response-invalid", "openrouter");
    }

    normalizedModels.push({
      contextWindowTokens: model.context_length,
      defaultReasoningOption: reasoning.defaultReasoningOption,
      displayName: model.name,
      id: model.id,
      maxOutputTokens: Math.min(maxOutputTokens, MODEL_PROVIDER_MAX_OUTPUT_TOKENS),
      protocol: "openai-chat-completions",
      reasoningOptions: reasoning.reasoningOptions,
      supportsImageInput: model.architecture.input_modalities.includes("image"),
      supportsTools: true,
    });
  }

  return normalizedModels;
}
