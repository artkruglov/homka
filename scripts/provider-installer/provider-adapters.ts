/**
 * Live provider adapters for the interactive installer.
 *
 * Exports:
 * - `ProviderAdapterDependencies`: explicit network, timeout, catalog, and smoke dependencies.
 * - `createProviderAdapters`: creates installer-ready live catalog and exact smoke callbacks.
 *
 * Key constructs:
 * - Strict installer-ready narrowing without fabricated capability or limit defaults.
 * - Schema-v4 config construction before the real two-step provider smoke.
 * - Stable application-error translation at the CLI boundary.
 */
import type { FetchFunction } from "@ai-sdk/provider-utils";

import { isAppError } from "../../agent/lib/app-error.js";
import { buildModelProviderConfig } from "../../agent/lib/provider-catalog/model-provider-config-builder.js";
import {
  validateModelProviderSmoke,
  type ModelProviderSmokeOptions,
} from "../../agent/lib/provider-catalog/model-provider-smoke-validator.js";
import {
  fetchProviderCatalog,
  type FetchProviderCatalogOptions,
  type ProviderCatalogModel,
} from "../../agent/lib/provider-catalog/provider-catalog.js";
import type { ListModels, NormalizedModel, ValidateModel } from "./contracts.js";
import { InstallerError } from "./errors.js";

type FetchProviderCatalog = (
  options: FetchProviderCatalogOptions,
) => Promise<ProviderCatalogModel[]>;
type ValidateModelProviderSmoke = (options: ModelProviderSmokeOptions) => Promise<void>;

export interface ProviderAdapterDependencies {
  readonly catalogTimeoutMs: number;
  readonly fetch: FetchFunction;
  readonly fetchProviderCatalog?: FetchProviderCatalog;
  readonly smokeTimeoutMs: number;
  readonly validateModelProviderSmoke?: ValidateModelProviderSmoke;
}

/** Required fields remain nullable at the provider boundary and are copied only when proven. */
function normalizeInstallerReadyModel(model: ProviderCatalogModel): NormalizedModel | null {
  const complete = Number.isInteger(model.contextWindowTokens)
    && model.contextWindowTokens !== null
    && model.contextWindowTokens > 0
    && Number.isInteger(model.maxOutputTokens)
    && model.maxOutputTokens !== null
    && model.maxOutputTokens > 0
    && typeof model.supportsImageInput === "boolean"
    && model.supportsTools === true;
  if (!complete) return null;

  return {
    contextWindowTokens: model.contextWindowTokens as number,
    defaultReasoningOption: model.defaultReasoningOption,
    displayName: model.displayName,
    id: model.id,
    maxOutputTokens: model.maxOutputTokens as number,
    protocol: model.protocol,
    reasoningOptions: [...model.reasoningOptions],
    supportsImageInput: model.supportsImageInput as boolean,
    supportsTools: true,
  };
}

/** Application failures retain their stable code; raw integration failures get a safe boundary code. */
async function translateProviderError<T>(
  operation: () => Promise<T>,
  unexpected: { readonly code: string; readonly message: string },
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isAppError(error)) {
      throw new InstallerError(error.code, error.message.slice(error.code.length + 2), {
        cause: error,
      });
    }
    throw new InstallerError(unexpected.code, unexpected.message, { cause: error });
  }
}

/** Binds provider-domain APIs to the smaller installer callback surface. */
export function createProviderAdapters(dependencies: ProviderAdapterDependencies): {
  listModels: ListModels;
  validateModel: ValidateModel;
} {
  const loadCatalog = dependencies.fetchProviderCatalog ?? fetchProviderCatalog;
  const runSmoke = dependencies.validateModelProviderSmoke ?? validateModelProviderSmoke;

  const listModels: ListModels = async (provider, apiKey) => translateProviderError(
    async () => {
      const models = await loadCatalog({
        apiKey,
        fetch: dependencies.fetch,
        providerId: provider,
        timeoutMs: dependencies.catalogTimeoutMs,
      });
      return models.flatMap((model) => {
        const normalized = normalizeInstallerReadyModel(model);
        return normalized ? [normalized] : [];
      });
    },
    {
      code: "OSINARA_INSTALL_MODEL_CATALOG_FAILED",
      message: "Не удалось загрузить каталог моделей. Проверьте сеть и API-ключ поставщика",
    },
  );

  const validateModel: ValidateModel = async (provider, apiKey, model, reasoning) => {
    await translateProviderError(
      async () => {
        // Voice is chosen after model validation, so the smoke config intentionally disables it.
        const config = buildModelProviderConfig(provider, {
          ...model,
          reasoningOptions: [...model.reasoningOptions],
        }, reasoning, false);
        await runSmoke({
          apiKey,
          config,
          fetch: dependencies.fetch,
          timeoutMs: dependencies.smokeTimeoutMs,
        });
      },
      {
        code: "OSINARA_INSTALL_MODEL_SMOKE_FAILED",
        message: "Не удалось проверить выбранную модель. Проверьте сеть, API-ключ и доступ к модели",
      },
    );
  };

  return { listModels, validateModel };
}
