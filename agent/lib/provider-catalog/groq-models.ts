/**
 * Maintained Groq model metadata required by the installer.
 *
 * Exports:
 * - `selectSupportedGroqModels`: intersects live model IDs with audited runtime metadata.
 *
 * Key constructs:
 * - Exact limits and capabilities come from Groq's model and reasoning documentation.
 * - Live `/models` availability remains mandatory because Qwen 3.8 is a preview model.
 */
import type { ProviderCatalogModel, ProviderProtocol } from "./provider-catalog-types.js";

interface LiveGroqModel {
  readonly id: string;
  readonly protocol: ProviderProtocol;
}

const SUPPORTED_MODELS: Readonly<Record<string, ProviderCatalogModel>> = {
  "qwen/qwen3.8-27b": {
    contextWindowTokens: 131_042,
    defaultReasoningOption: { type: "none" },
    displayName: "Qwen 3.8 27B",
    id: "qwen/qwen3.8-27b",
    maxOutputTokens: 16_384,
    protocol: "openai-chat-completions",
    reasoningOptions: [
      { type: "none" },
      { effort: "low", type: "effort" },
      { effort: "medium", type: "effort" },
      { effort: "high", type: "effort" },
    ],
    supportsImageInput: true,
    supportsTools: true,
  },
};

export function selectSupportedGroqModels(
  liveModels: readonly LiveGroqModel[],
): ProviderCatalogModel[] {
  return liveModels.flatMap(({ id, protocol }) => {
    const model = SUPPORTED_MODELS[id];
    if (!model || model.protocol !== protocol) return [];
    return [{
      ...model,
      defaultReasoningOption: model.defaultReasoningOption
        ? { ...model.defaultReasoningOption }
        : null,
      reasoningOptions: model.reasoningOptions.map((option) => ({ ...option })),
    }];
  });
}
