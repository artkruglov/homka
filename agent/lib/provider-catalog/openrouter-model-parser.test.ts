/**
 * OpenRouter provider catalog tests.
 *
 * Constructs covered:
 * - Tool and text-input capability filtering.
 * - Context, output, image, and display metadata normalization.
 * - Provider output limits are capped at the application-tested runtime maximum.
 * - Metadata-driven optional and mandatory reasoning choices and defaults.
 * - Null effort allowlists and contradictory metadata handling.
 */
import { describe, expect, it } from "vitest";

import { fetchProviderCatalog, type ProviderCatalogModel } from "./provider-catalog.js";
import {
  createFetch,
  expectAppError,
  jsonResponse,
  REQUEST_TIMEOUT_MS,
} from "./provider-catalog-test-helpers.js";

describe("OpenRouter provider catalog", () => {
  it("filters models by tools and text input and derives reasoning choices", async () => {
    const fetch = createFetch(jsonResponse({
      data: [
        {
          architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
          context_length: 200_000,
          id: "vendor/agent-model",
          name: "Agent Model",
          reasoning: {
            default_effort: "medium",
            default_enabled: true,
            mandatory: false,
            supported_efforts: ["high", "medium", "low"],
          },
          supported_parameters: ["tools", "tool_choice", "reasoning"],
          top_provider: { is_moderated: false, max_completion_tokens: 32_000 },
        },
        {
          architecture: { input_modalities: ["text"], output_modalities: ["text"] },
          context_length: 64_000,
          id: "vendor/no-tools",
          name: "No Tools",
          supported_parameters: ["reasoning"],
          top_provider: { is_moderated: false, max_completion_tokens: 8_000 },
        },
        {
          architecture: { input_modalities: ["image"], output_modalities: ["text"] },
          context_length: 64_000,
          id: "vendor/no-text",
          name: "No Text",
          supported_parameters: ["tools"],
          top_provider: { is_moderated: false, max_completion_tokens: null },
        },
        {
          architecture: { input_modalities: ["text"], output_modalities: ["text"] },
          context_length: 64_000,
          id: "vendor/no-output-limit",
          name: "No Output Limit",
          supported_parameters: ["tools"],
          top_provider: { is_moderated: false, max_completion_tokens: null },
        },
      ],
    }));

    const models = await fetchProviderCatalog({
      fetch,
      providerId: "openrouter",
      timeoutMs: REQUEST_TIMEOUT_MS,
    });

    expect(fetch).toHaveBeenCalledWith("https://openrouter.ai/api/v1/models", {
      headers: {},
      method: "GET",
      signal: expect.any(AbortSignal),
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(models).toEqual<ProviderCatalogModel[]>([
      {
        contextWindowTokens: 200_000,
        defaultReasoningOption: { effort: "medium", type: "effort" },
        displayName: "Agent Model",
        id: "vendor/agent-model",
        maxOutputTokens: 32_000,
        protocol: "openai-chat-completions",
        reasoningOptions: [
          { type: "none" },
          { effort: "high", type: "effort" },
          { effort: "medium", type: "effort" },
          { effort: "low", type: "effort" },
        ],
        supportsImageInput: true,
        supportsTools: true,
      },
    ]);
  });

  it("caps an upstream output limit at the canonical runtime maximum", async () => {
    const fetch = createFetch(jsonResponse({
      data: [{
        architecture: { input_modalities: ["text"], output_modalities: ["text"] },
        context_length: 1_000_000,
        id: "vendor/large-output-model",
        name: "Large Output Model",
        supported_parameters: ["tools"],
        top_provider: { is_moderated: false, max_completion_tokens: 384_000 },
      }],
    }));

    const [model] = await fetchProviderCatalog({
      fetch,
      providerId: "openrouter",
      timeoutMs: REQUEST_TIMEOUT_MS,
    });

    expect(model.maxOutputTokens).toBe(128_000);
  });

  it("uses mandatory and supported_parameters when building reasoning options", async () => {
    const fetch = createFetch(jsonResponse({
      data: [
        {
          architecture: { input_modalities: ["text"], output_modalities: ["text"] },
          context_length: 100_000,
          id: "vendor/mandatory-reasoning",
          name: "Mandatory Reasoning",
          reasoning: {
            default_effort: "high",
            default_enabled: true,
            mandatory: true,
            supported_efforts: ["high", "low", "none"],
          },
          supported_parameters: ["tools", "reasoning_effort"],
          top_provider: { is_moderated: true, max_completion_tokens: 20_000 },
        },
        {
          architecture: { input_modalities: ["text"], output_modalities: ["text"] },
          context_length: 100_000,
          id: "vendor/no-reasoning-control",
          name: "No Reasoning Control",
          reasoning: {
            default_effort: "medium",
            default_enabled: true,
            mandatory: false,
            supported_efforts: ["medium", "low"],
          },
          supported_parameters: ["tools", "include_reasoning"],
          top_provider: { is_moderated: true, max_completion_tokens: 10_000 },
        },
      ],
    }));

    const models = await fetchProviderCatalog({
      fetch,
      providerId: "openrouter",
      timeoutMs: REQUEST_TIMEOUT_MS,
    });

    expect(models).toEqual([
      expect.objectContaining({
        defaultReasoningOption: { effort: "high", type: "effort" },
        id: "vendor/mandatory-reasoning",
        reasoningOptions: [
          { effort: "high", type: "effort" },
          { effort: "low", type: "effort" },
        ],
      }),
      expect.objectContaining({
        defaultReasoningOption: null,
        id: "vendor/no-reasoning-control",
        reasoningOptions: [],
      }),
    ]);
  });

  it("uses none as the default only when metadata disables reasoning", async () => {
    const fetch = createFetch(jsonResponse({
      data: [{
        architecture: { input_modalities: ["text"], output_modalities: ["text"] },
        context_length: 32_000,
        id: "vendor/optional-reasoning",
        name: "Optional Reasoning",
        reasoning: {
          default_enabled: false,
          mandatory: false,
          supported_efforts: ["medium"],
        },
        supported_parameters: ["tools", "reasoning"],
        top_provider: { is_moderated: false, max_completion_tokens: 4_000 },
      }],
    }));

    const [model] = await fetchProviderCatalog({
      fetch,
      providerId: "openrouter",
      timeoutMs: REQUEST_TIMEOUT_MS,
    });

    expect(model).toMatchObject({
      defaultReasoningOption: { type: "none" },
      reasoningOptions: [
        { type: "none" },
        { effort: "medium", type: "effort" },
      ],
    });
  });

  it("expands a null supported_efforts allowlist to documented gateway efforts", async () => {
    const fetch = createFetch(jsonResponse({
      data: [{
        architecture: { input_modalities: ["text"], output_modalities: ["text"] },
        context_length: 32_000,
        id: "vendor/all-efforts",
        name: "All Efforts",
        reasoning: {
          default_effort: "medium",
          mandatory: false,
          supported_efforts: null,
        },
        supported_parameters: ["tools", "reasoning_effort"],
        top_provider: { is_moderated: false, max_completion_tokens: 4_000 },
      }],
    }));

    const [model] = await fetchProviderCatalog({
      fetch,
      providerId: "openrouter",
      timeoutMs: REQUEST_TIMEOUT_MS,
    });

    expect(model.reasoningOptions).toEqual([
      { type: "none" },
      { effort: "max", type: "effort" },
      { effort: "xhigh", type: "effort" },
      { effort: "high", type: "effort" },
      { effort: "medium", type: "effort" },
      { effort: "low", type: "effort" },
      { effort: "minimal", type: "effort" },
    ]);
  });

  it("does not invent choices when supported_efforts metadata is absent", async () => {
    const fetch = createFetch(jsonResponse({
      data: [{
        architecture: { input_modalities: ["text"], output_modalities: ["text"] },
        context_length: 32_000,
        id: "vendor/unknown-efforts",
        name: "Unknown Efforts",
        reasoning: { mandatory: false },
        supported_parameters: ["tools", "reasoning"],
        top_provider: { is_moderated: false, max_completion_tokens: 4_000 },
      }],
    }));

    const [model] = await fetchProviderCatalog({
      fetch,
      providerId: "openrouter",
      timeoutMs: REQUEST_TIMEOUT_MS,
    });

    expect(model).toMatchObject({
      defaultReasoningOption: null,
      reasoningOptions: [],
    });
  });

  it("rejects an inconsistent reasoning default", async () => {
    const fetch = createFetch(jsonResponse({
      data: [{
        architecture: { input_modalities: ["text"], output_modalities: ["text"] },
        context_length: 32_000,
        id: "vendor/broken-reasoning",
        name: "Broken Reasoning",
        reasoning: {
          default_effort: "high",
          mandatory: true,
          supported_efforts: ["low"],
        },
        supported_parameters: ["tools", "reasoning_effort"],
        top_provider: { is_moderated: false, max_completion_tokens: 4_000 },
      }],
    }));

    await expectAppError(
      fetchProviderCatalog({ fetch, providerId: "openrouter", timeoutMs: REQUEST_TIMEOUT_MS }),
      "AGENT_PROVIDER_CATALOG_RESPONSE_INVALID",
      "Провайдер openrouter вернул каталог моделей в неподдерживаемом формате",
    );
  });
});
