/**
 * Provider installer adapter tests.
 *
 * Constructs covered:
 * - `createProviderAdapters`: binds live catalog and smoke validation to installer contracts.
 * - Installer-ready narrowing: excludes models with incomplete required metadata.
 * - Error translation: preserves stable application codes and Russian messages at the CLI boundary.
 */
import { describe, expect, it, vi } from "vitest";

import { AppError } from "../../agent/lib/app-error.js";
import type { ModelProviderConfig } from "../../agent/lib/model-provider-config-schema.js";
import type { ProviderCatalogModel } from "../../agent/lib/provider-catalog/provider-catalog.js";
import type { NormalizedModel } from "./contracts.js";
import { createProviderAdapters } from "./provider-adapters.js";

const completeModel: NormalizedModel = {
  contextWindowTokens: 128_000,
  defaultReasoningOption: { effort: "high", type: "effort" },
  displayName: "DeepSeek Reasoner",
  id: "deepseek-reasoner",
  maxOutputTokens: 16_000,
  protocol: "openai-chat-completions",
  reasoningOptions: [{ effort: "high", type: "effort" }],
  supportsImageInput: false,
  supportsTools: true,
};

describe("createProviderAdapters", () => {
  it("loads the exact provider catalog and excludes incomplete model metadata", async () => {
    const fetchProviderCatalog = vi.fn().mockResolvedValue([
      completeModel,
      { ...completeModel, contextWindowTokens: null, id: "missing-context" },
      { ...completeModel, id: "missing-tools", supportsTools: null },
    ]);
    const fetch = vi.fn();
    const adapters = createProviderAdapters({
      catalogTimeoutMs: 10_000,
      fetch,
      fetchProviderCatalog,
      smokeTimeoutMs: 30_000,
      validateModelProviderSmoke: vi.fn(),
    });

    await expect(adapters.listModels("deepseek", "provider-key")).resolves.toEqual([
      completeModel,
    ]);
    expect(fetchProviderCatalog).toHaveBeenCalledWith({
      apiKey: "provider-key",
      fetch,
      providerId: "deepseek",
      timeoutMs: 10_000,
    });
  });

  it("builds the selected schema-v4 config before running the exact smoke", async () => {
    const validateModelProviderSmoke = vi.fn().mockResolvedValue(undefined);
    const fetch = vi.fn();
    const adapters = createProviderAdapters({
      catalogTimeoutMs: 10_000,
      fetch,
      fetchProviderCatalog: vi.fn(),
      smokeTimeoutMs: 30_000,
      validateModelProviderSmoke,
    });

    await adapters.validateModel(
      "deepseek",
      "provider-key",
      completeModel,
      { effort: "high", type: "effort" },
    );

    expect(validateModelProviderSmoke).toHaveBeenCalledWith({
      apiKey: "provider-key",
      config: expect.objectContaining({
        provider: "deepseek",
        schemaVersion: 4,
        voice: { enabled: false },
      }) as ModelProviderConfig,
      fetch,
      timeoutMs: 30_000,
    });
  });

  it("preserves expected application diagnostics for the installer CLI", async () => {
    const adapters = createProviderAdapters({
      catalogTimeoutMs: 10_000,
      fetch: vi.fn(),
      fetchProviderCatalog: vi.fn().mockRejectedValue(new AppError(
        "AGENT_PROVIDER_CATALOG_AUTH_REQUIRED",
        "Для загрузки каталога deepseek нужен API-ключ",
      )),
      smokeTimeoutMs: 30_000,
      validateModelProviderSmoke: vi.fn(),
    });

    await expect(adapters.listModels("deepseek", "invalid-key")).rejects.toMatchObject({
      code: "AGENT_PROVIDER_CATALOG_AUTH_REQUIRED",
      message: "AGENT_PROVIDER_CATALOG_AUTH_REQUIRED: Для загрузки каталога deepseek нужен API-ключ",
    });
  });

  it("adds a stable safe diagnostic when the provider smoke fails outside AppError", async () => {
    const adapters = createProviderAdapters({
      catalogTimeoutMs: 10_000,
      fetch: vi.fn(),
      fetchProviderCatalog: vi.fn(),
      smokeTimeoutMs: 30_000,
      validateModelProviderSmoke: vi.fn().mockRejectedValue(new Error(
        "HTTP 401 response with internal provider details",
      )),
    });

    await expect(adapters.validateModel(
      "deepseek",
      "invalid-key",
      completeModel,
      { effort: "high", type: "effort" },
    )).rejects.toMatchObject({
      code: "OSINARA_INSTALL_MODEL_SMOKE_FAILED",
      message: expect.stringContaining(
        "OSINARA_INSTALL_MODEL_SMOKE_FAILED: Не удалось проверить выбранную модель",
      ),
    });
  });
});
