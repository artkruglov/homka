/**
 * Model transport retry observability tests.
 *
 * Constructs covered:
 * - AI SDK retries two provider-declared overload responses before succeeding.
 * - Every failed physical provider attempt emits one structured application log.
 */
import { generateText } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createConfiguredLanguageModel } from "./model-transport.js";

function overloadedResponse(): Response {
  return new Response(JSON.stringify({
    error: {
      message: "The server cluster is currently under high load. (2064)",
      type: "overloaded_error",
    },
    type: "error",
  }), {
    headers: { "content-type": "application/json" },
    status: 529,
  });
}

function successfulResponse(): Response {
  return new Response(JSON.stringify({
    content: [{ text: "Готово", type: "text" }],
    id: "msg_retry_001",
    model: "MiniMax-M3",
    role: "assistant",
    stop_reason: "end_turn",
    stop_sequence: null,
    type: "message",
    usage: { input_tokens: 1, output_tokens: 1 },
  }), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("model transport retry policy", () => {
  it("retries two overloaded responses and logs every failed physical attempt", async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const responses = [overloadedResponse(), overloadedResponse(), successfulResponse()];
    const fetch = vi.fn(async () => {
      const response = responses.shift();
      if (!response) throw new Error("Unexpected model request");
      return response;
    });
    const model = createConfiguredLanguageModel({
      apiKey: "model-secret",
      fetch,
      maxOutputTokens: 128_000,
      modelId: "MiniMax-M3",
      transport: {
        authentication: "bearer",
        // The mock accepts this deliberately malformed provider URL so the log must redact its query.
        baseUrl: "https://api.minimax.io/anthropic/v1?api_key=provider-secret",
        protocol: "anthropic-messages",
        reasoning: { mode: "adaptive", type: "enabled" },
      },
    });

    const result = generateText({ maxRetries: 2, model, prompt: "Проверка" });
    await vi.runAllTimersAsync();
    await expect(result).resolves.toMatchObject({ text: "Готово" });
    expect(fetch).toHaveBeenCalledTimes(3);
    const transientLog = JSON.stringify({
      code: "AGENT_MODEL_TRANSIENT_RESPONSE",
      modelId: "MiniMax-M3",
      statusCode: 529,
      url: "https://api.minimax.io/anthropic/v1",
    });
    expect(log).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenNthCalledWith(1, transientLog);
    expect(log).toHaveBeenNthCalledWith(2, transientLog);
  });
});
