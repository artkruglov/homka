/**
 * Models.dev metadata parser and installer-ready model enricher.
 *
 * Exports:
 * - `enrichModelsFromModelsDev`: intersects live IDs with one provider metadata namespace.
 *
 * Key constructs:
 * - Partial model candidates are validated but excluded unless installer metadata is complete.
 * - Reasoning options are translated only when the selected transport can express them.
 * - Unsupported budget-token controls and unknown live IDs never receive guessed settings.
 */
import { z } from "zod";

import { MODEL_PROVIDER_MAX_OUTPUT_TOKENS } from "../model-provider-limits.js";
import { providerCatalogError } from "./provider-catalog-errors.js";
import type {
  ProviderCatalogModel,
  ProviderId,
  ProviderProtocol,
  ReasoningEffort,
  ReasoningSelection,
} from "./provider-catalog-types.js";

const reasoningEffortSchema = z.enum([
  "max",
  "xhigh",
  "high",
  "medium",
  "low",
  "minimal",
  "none",
]);
const reasoningOptionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("toggle") }).passthrough(),
  z.object({ type: z.literal("effort"), values: z.array(reasoningEffortSchema) }).passthrough(),
  z.object({ type: z.literal("budget_tokens"), max: z.number().positive() }).passthrough(),
]);
const modelCandidateSchema = z.object({
  id: z.string().trim().min(1).optional(),
  limit: z.object({
    context: z.number().optional(),
    output: z.number().optional(),
  }).passthrough().optional(),
  modalities: z.object({
    input: z.array(z.string().trim().min(1)),
    output: z.array(z.string().trim().min(1)),
  }).passthrough().optional(),
  name: z.string().trim().min(1).optional(),
  reasoning_options: z.array(reasoningOptionSchema).optional(),
  tool_call: z.boolean().optional(),
}).passthrough();
const providerMetadataSchema = z.object({
  id: z.string().trim().min(1),
  models: z.record(z.string(), modelCandidateSchema),
  name: z.string().trim().min(1),
}).passthrough();
const metadataCatalogSchema = z.record(z.string(), z.unknown());

type ModelCandidate = z.infer<typeof modelCandidateSchema>;
type MetadataProviderId = Exclude<ProviderId, "groq" | "openrouter">;
type MetadataReasoningEffort = z.infer<typeof reasoningEffortSchema>;

const EXPRESSIBLE_EFFORTS = new Set<ReasoningEffort>(["low", "high", "max"]);

/** Toggle semantics differ because current Anthropic and OpenAI transports expose different knobs. */
function toggleSelections(
  providerId: MetadataProviderId,
  protocol: ProviderProtocol,
): ReasoningSelection[] {
  if (protocol === "anthropic-messages") {
    return [{ type: "none" }, { mode: "adaptive", type: "enabled" }];
  }
  // OpenAI transports can disable reasoning; enabling without a documented effort is not expressible.
  return [{ type: "none" }];
}

/** Effort metadata is filtered against the exact effort union accepted by the current transport. */
function effortSelections(values: MetadataReasoningEffort[]): ReasoningSelection[] {
  const selections: ReasoningSelection[] = [];
  for (const effort of values) {
    if (effort === "none") {
      selections.push({ type: "none" });
    } else if (EXPRESSIBLE_EFFORTS.has(effort)) {
      selections.push({ effort, type: "effort" });
    }
  }
  return selections;
}

/** Preserves metadata order while removing selections duplicated across toggle and effort entries. */
function reasoningSelections(
  model: ModelCandidate,
  providerId: MetadataProviderId,
  protocol: ProviderProtocol,
): ReasoningSelection[] {
  const selections = (model.reasoning_options ?? []).flatMap((option) => {
    if (option.type === "toggle") return toggleSelections(providerId, protocol);
    if (option.type === "effort" && protocol === "openai-chat-completions") {
      return effortSelections(option.values);
    }
    return [];
  });
  const seen = new Set<string>();
  return selections.filter((selection) => {
    const key = JSON.stringify(selection);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Missing or non-positive limits and missing agent capabilities make a model unsafe to install. */
function normalizeCompleteModel(
  modelId: string,
  model: ModelCandidate,
  providerId: MetadataProviderId,
  protocol: ProviderProtocol,
): ProviderCatalogModel | null {
  const context = model.limit?.context;
  const output = model.limit?.output;
  const hasPositiveLimits = Number.isInteger(context) && context! > 0
    && Number.isInteger(output) && output! > 0;
  if (!hasPositiveLimits || !model.name || model.tool_call !== true) return null;
  if (!model.modalities?.input.includes("text")) return null;

  return {
    contextWindowTokens: context!,
    defaultReasoningOption: null,
    displayName: model.name,
    id: modelId,
    maxOutputTokens: Math.min(output!, MODEL_PROVIDER_MAX_OUTPUT_TOKENS),
    protocol,
    reasoningOptions: reasoningSelections(model, providerId, protocol),
    supportsImageInput: model.modalities.input.includes("image"),
    supportsTools: true,
  };
}

/** Metadata contributes properties only; live provider order and IDs remain authoritative. */
export function enrichModelsFromModelsDev(
  body: unknown,
  providerId: MetadataProviderId,
  liveModels: Array<{ id: string; protocol: ProviderProtocol }>,
): ProviderCatalogModel[] {
  const catalogResult = metadataCatalogSchema.safeParse(body);
  if (!catalogResult.success) {
    throw providerCatalogError("metadata-response-invalid", providerId);
  }

  const providerResult = providerMetadataSchema.safeParse(catalogResult.data[providerId]);
  if (!providerResult.success || providerResult.data.id !== providerId) {
    throw providerCatalogError("metadata-response-invalid", providerId);
  }

  return liveModels.flatMap(({ id, protocol }) => {
    const metadata = providerResult.data.models[id];
    if (!metadata || metadata.id !== id) return [];
    const normalized = normalizeCompleteModel(id, metadata, providerId, protocol);
    return normalized ? [normalized] : [];
  });
}
