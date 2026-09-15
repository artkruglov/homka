/**
 * Interactive provider/model reconfiguration workflow.
 *
 * Exports:
 * - `ConfigCommandDependencies`: prompts, live provider adapters, and atomic apply boundary.
 * - `runInteractiveConfigCommand`: selects, smokes, builds, and applies one exact model config.
 */
import { buildModelProviderConfig } from "../../agent/lib/provider-catalog/model-provider-config-builder.js";
import type { ApplyModelConfigurationInput } from "../model-config/contracts.js";
import type {
  ListModels,
  ModelProvider,
  NormalizedModel,
  PromptAdapter,
  ReasoningSelection,
  ValidateModel,
} from "./contracts.js";
import { MODEL_PROVIDER_OPTIONS, requireCredential } from "./configuration.js";
import { InstallerError } from "./errors.js";
import {
  decodeReasoningSelection,
  encodeReasoningSelection,
  reasoningSelectionLabel,
} from "./reasoning-selection.js";

export interface ConfigCommandDependencies {
  readonly apply: (input: ApplyModelConfigurationInput) => Promise<unknown>;
  readonly listModels: ListModels;
  readonly prompts: PromptAdapter;
  readonly validateGroq: (apiKey: string) => Promise<void>;
  readonly validateModel: ValidateModel;
}

async function selectModel(
  provider: ModelProvider,
  apiKey: string,
  dependencies: ConfigCommandDependencies,
): Promise<NormalizedModel> {
  const models = await dependencies.listModels(provider, apiKey);
  if (models.length === 0) {
    throw new InstallerError(
      "OSINARA_CONFIG_MODEL_CATALOG_EMPTY",
      "Поставщик не вернул доступных моделей с полными обязательными возможностями",
    );
  }
  const id = await dependencies.prompts.select(
    "Выберите модель",
    models.map((candidate) => ({ label: candidate.displayName, value: candidate.id })),
  );
  const model = models.find((candidate) => candidate.id === id);
  if (!model) throw new InstallerError(
    "OSINARA_CONFIG_MODEL_SELECTION_INVALID",
    "Выбранная модель отсутствует в актуальном каталоге",
  );
  return model;
}

async function selectReasoning(
  model: NormalizedModel,
  prompts: PromptAdapter,
): Promise<ReasoningSelection | null> {
  if (model.reasoningOptions.length === 0) return null;
  if (model.reasoningOptions.length === 1) return model.reasoningOptions[0] as ReasoningSelection;
  const id = await prompts.select(
    `Выберите reasoning для ${model.displayName}`,
    model.reasoningOptions.map((option) => ({
      label: reasoningSelectionLabel(option),
      value: encodeReasoningSelection(option),
    })),
  );
  const selected = decodeReasoningSelection(id);
  if (!model.reasoningOptions.some((option) => encodeReasoningSelection(option) === id)) {
    throw new InstallerError(
      "OSINARA_CONFIG_REASONING_SELECTION_INVALID",
      "Выбранный reasoning недоступен для этой модели",
    );
  }
  return selected;
}

export async function runInteractiveConfigCommand(
  dependencies: ConfigCommandDependencies,
): Promise<unknown> {
  const provider = await dependencies.prompts.select(
    "Выберите поставщика модели",
    MODEL_PROVIDER_OPTIONS,
  );
  const modelApiKey = requireCredential(
    await dependencies.prompts.secret("Введите API-ключ выбранного поставщика модели"),
    "API-ключ модели",
  );
  const model = await selectModel(provider, modelApiKey, dependencies);
  const reasoning = await selectReasoning(model, dependencies.prompts);
  await dependencies.validateModel(provider, modelApiKey, model, reasoning);
  const voiceEnabled = await dependencies.prompts.confirm(
    "Включить расшифровку голосовых сообщений через Groq?",
  );
  const groqApiKey = voiceEnabled
    ? requireCredential(await dependencies.prompts.secret("Введите Groq API key"), "Groq API key")
    : undefined;
  if (groqApiKey !== undefined) await dependencies.validateGroq(groqApiKey);
  const config = buildModelProviderConfig(provider, {
    ...model,
    reasoningOptions: [...model.reasoningOptions],
  }, reasoning, voiceEnabled);
  return await dependencies.apply({
    configBytes: Buffer.from(`${JSON.stringify(config, null, 2)}\n`, "utf8"),
    groqApiKey,
    modelApiKey,
  });
}
