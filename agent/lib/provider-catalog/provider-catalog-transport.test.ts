/**
 * Provider catalog transport boundary tests.
 *
 * Constructs covered:
 * - One absolute deadline and AbortSignal shared by live and metadata requests.
 * - Bounded headers and body consumption even when injected fetch ignores cancellation.
 * - Stable live-provider and models.dev HTTP, network, schema, and timeout errors.
 */
import { describe, expect, it, vi } from "vitest";

import { fetchProviderCatalog, type ProviderCatalogFetch } from "./provider-catalog.js";
import {
  createFetch,
  expectAppError,
  jsonResponse,
  REQUEST_TIMEOUT_MS,
} from "./provider-catalog-test-helpers.js";

const DEEPSEEK_MODELS_URL = "https://api.deepseek.com/models";
const MODELS_DEV_URL = "https://models.dev/api.json";

/** Routes injected requests by URL for transport failures involving the two boundaries. */
function createCatalogFetch(responses: Record<string, Response>): ProviderCatalogFetch {
  return vi.fn(async (input) => {
    const response = responses[input.toString()];
    if (!response) throw new Error(`Unexpected test URL: ${input.toString()}`);
    return response;
  });
}

describe("provider catalog transport", () => {
  it("uses one deadline and AbortSignal for live and models.dev requests", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const fetch: ProviderCatalogFetch = vi.fn((input, init) => {
      signals.push(init?.signal as AbortSignal);
      if (input.toString() === DEEPSEEK_MODELS_URL) {
        return Promise.resolve(jsonResponse({ object: "list", data: [] }));
      }
      return new Promise<Response>(() => undefined);
    });

    const outcome = fetchProviderCatalog({
      apiKey: "secret",
      fetch,
      providerId: "deepseek",
      timeoutMs: REQUEST_TIMEOUT_MS,
    }).then((value) => ({ value }), (error: unknown) => ({ error }));
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);

    expect(await outcome).toEqual({
      error: expect.objectContaining({ code: "AGENT_PROVIDER_CATALOG_TIMEOUT" }),
    });
    expect(signals).toHaveLength(2);
    expect(signals[0]).toBe(signals[1]);
    expect(signals[0]?.aborted).toBe(true);
    vi.useRealTimers();
  });

  it.each([
    [jsonResponse({ error: "unavailable" }, 503), "AGENT_PROVIDER_METADATA_HTTP_FAILED"],
    [jsonResponse({ deepseek: { id: "deepseek", models: [] } }), "AGENT_PROVIDER_METADATA_RESPONSE_INVALID"],
  ] as const)("fails fast for invalid models.dev metadata %#", async (metadataResponse, code) => {
    const fetch = createCatalogFetch({
      [DEEPSEEK_MODELS_URL]: jsonResponse({ object: "list", data: [] }),
      [MODELS_DEV_URL]: metadataResponse,
    });

    await expectAppError(
      fetchProviderCatalog({
        apiKey: "secret",
        fetch,
        providerId: "deepseek",
        timeoutMs: REQUEST_TIMEOUT_MS,
      }),
      code,
      code === "AGENT_PROVIDER_METADATA_HTTP_FAILED"
        ? "Не удалось загрузить метаданные моделей. Попробуйте ещё раз"
        : "Сервис метаданных вернул каталог моделей в неподдерживаемом формате",
    );
  });

  it("returns a stable error when models.dev cannot be reached", async () => {
    const fetch: ProviderCatalogFetch = vi.fn((input) => {
      if (input.toString() === DEEPSEEK_MODELS_URL) {
        return Promise.resolve(jsonResponse({ object: "list", data: [] }));
      }
      return Promise.reject(new Error("network down"));
    });

    await expectAppError(
      fetchProviderCatalog({
        apiKey: "secret",
        fetch,
        providerId: "deepseek",
        timeoutMs: REQUEST_TIMEOUT_MS,
      }),
      "AGENT_PROVIDER_METADATA_REQUEST_FAILED",
      "Не удалось получить метаданные моделей. Проверьте подключение и попробуйте ещё раз",
    );
  });

  it.each([
    ["deepseek", { object: "list", data: [{ object: "model", owned_by: "deepseek" }] }],
    ["groq", { object: "list", data: [{ id: "", object: "model", owned_by: "Qwen" }] }],
    ["minimax", { object: "list", data: "MiniMax-M3" }],
    ["opencode-go", { object: "list", data: [{ id: "", object: "model", owned_by: "opencode" }] }],
    ["openrouter", { data: [{ id: "vendor/broken" }] }],
  ] as const)("rejects a malformed %s response", async (providerId, body) => {
    const fetch = createFetch(jsonResponse(body));

    await expectAppError(
      fetchProviderCatalog({
        apiKey: providerId === "deepseek" || providerId === "groq" || providerId === "minimax"
          ? "secret"
          : undefined,
        fetch,
        providerId,
        timeoutMs: REQUEST_TIMEOUT_MS,
      }),
      "AGENT_PROVIDER_CATALOG_RESPONSE_INVALID",
      `Провайдер ${providerId} вернул каталог моделей в неподдерживаемом формате`,
    );
  });

  it("returns a stable error for non-successful provider responses", async () => {
    const fetch = createFetch(jsonResponse({ error: "unauthorized" }, 401));

    await expectAppError(
      fetchProviderCatalog({
        apiKey: "expired-secret",
        fetch,
        providerId: "deepseek",
        timeoutMs: REQUEST_TIMEOUT_MS,
      }),
      "AGENT_PROVIDER_CATALOG_HTTP_FAILED",
      "Не удалось загрузить каталог deepseek. Проверьте API-ключ и доступ к провайдеру",
    );
  });

  it("aborts a request that exceeds its bounded timeout", async () => {
    vi.useFakeTimers();
    const fetch: ProviderCatalogFetch = vi.fn(() => new Promise<Response>(() => undefined));
    const outcome = fetchProviderCatalog({
      fetch,
      providerId: "openrouter",
      timeoutMs: REQUEST_TIMEOUT_MS,
    }).then((value) => ({ value }), (error: unknown) => ({ error }));
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);

    expect(await outcome).toEqual({
      error: expect.objectContaining({ code: "AGENT_PROVIDER_CATALOG_TIMEOUT" }),
    });
    vi.useRealTimers();
  });

  it("keeps the deadline active while reading the response body", async () => {
    vi.useFakeTimers();
    const stalledBody = new ReadableStream<Uint8Array>({ start: () => undefined });
    const fetch = createFetch(new Response(stalledBody, { status: 200 }));
    const outcome = fetchProviderCatalog({
      fetch,
      providerId: "openrouter",
      timeoutMs: REQUEST_TIMEOUT_MS,
    }).then((value) => ({ value }), (error: unknown) => ({ error }));
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);

    expect(await outcome).toEqual({
      error: expect.objectContaining({ code: "AGENT_PROVIDER_CATALOG_TIMEOUT" }),
    });
    vi.useRealTimers();
  });

  it.each([0, -1, 30_001, 1.5])("rejects an unsafe timeout value %s", async (timeoutMs) => {
    await expectAppError(
      fetchProviderCatalog({
        fetch: createFetch(jsonResponse({ data: [] })),
        providerId: "openrouter",
        timeoutMs,
      }),
      "AGENT_PROVIDER_CATALOG_TIMEOUT_INVALID",
      "Таймаут каталога должен быть целым числом от 1 до 30000 мс",
    );
  });
});
