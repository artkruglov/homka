/**
 * Configured model smoke validator tests.
 *
 * Constructs covered:
 * - `validateModelProviderSmoke`: performs an exact two-step tool-call handshake.
 * - Injected fetch observes retry-free, bounded requests through the real transport factory.
 * - Unexpected calls, final text, or step counts fail with stable application errors.
 */
import { describe, expect, it, vi } from "vitest";

import { buildModelProviderConfig } from "./model-provider-config-builder.js";
import { validateModelProviderSmoke } from "./model-provider-smoke-validator.js";
import type { ProviderCatalogModel } from "./provider-catalog.js";

const model: ProviderCatalogModel = {
  contextWindowTokens: 64_000,
  defaultReasoningOption: null,
  displayName: "OpenRouter model",
  id: "provider/model",
  maxOutputTokens: 8_000,
  protocol: "openai-chat-completions",
  reasoningOptions: [{ type: "none" }],
  supportsImageInput: false,
  supportsTools: true,
};

function completion(message: Record<string, unknown>, finishReason: string): Response {
  return new Response(JSON.stringify({
    choices: [{ finish_reason: finishReason, index: 0, message }],
    created: 1,
    id: "smoke-completion",
    model: model.id,
    object: "chat.completion",
    usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
  }), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}

function anthropicMessage(content: unknown[], stopReason: string): Response {
  return new Response(JSON.stringify({
    content,
    id: "smoke-message",
    model: model.id,
    role: "assistant",
    stop_reason: stopReason,
    stop_sequence: null,
    type: "message",
    usage: { input_tokens: 1, output_tokens: 1 },
  }), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}

describe("validateModelProviderSmoke", () => {
  it("requires the exact tool call and exact final text in two retry-free bounded steps", async () => {
    const requests: Array<{ body: Record<string, unknown>; signal: AbortSignal | null }> = [];
    const responses = [
      completion({
        content: null,
        role: "assistant",
        tool_calls: [{
          function: {
            arguments: JSON.stringify({ value: "OSINARA_MODEL_PROVIDER_SMOKE_READY" }),
            name: "confirm_model_provider",
          },
          id: "smoke-call-1",
          type: "function",
        }],
      }, "tool_calls"),
      completion({
        content: "OSINARA_MODEL_PROVIDER_SMOKE_OK",
        role: "assistant",
      }, "stop"),
    ];
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        signal: init?.signal ?? null,
      });
      const response = responses.shift();
      if (!response) throw new Error("Unexpected smoke request");
      return response;
    });
    const config = buildModelProviderConfig("openrouter", model, { type: "none" }, false);

    await expect(validateModelProviderSmoke({
      apiKey: "provider-secret",
      config,
      fetch,
      timeoutMs: 2_000,
    })).resolves.toBeUndefined();

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(requests[0]?.body).toMatchObject({
      tool_choice: { function: { name: "confirm_model_provider" }, type: "function" },
    });
    expect(requests[1]?.body).toMatchObject({ tool_choice: "none" });
    expect(requests.every(({ signal }) => signal instanceof AbortSignal)).toBe(true);
    expect(requests.every(({ signal }) => signal?.aborted === false)).toBe(true);
  });

  it("runs the same handshake through a direct Anthropic OpenCode Go gateway", async () => {
    const requests: Record<string, unknown>[] = [];
    const responses = [
      anthropicMessage([{
        id: "smoke-call-1",
        input: { value: "OSINARA_MODEL_PROVIDER_SMOKE_READY" },
        name: "confirm_model_provider",
        type: "tool_use",
      }], "tool_use"),
      anthropicMessage([{
        text: "OSINARA_MODEL_PROVIDER_SMOKE_OK",
        type: "text",
      }], "end_turn"),
    ];
    const anthropicModel: ProviderCatalogModel = {
      ...model,
      id: "minimax-m3",
      protocol: "anthropic-messages",
      reasoningOptions: [{ type: "none" }],
    };
    const config = buildModelProviderConfig(
      "opencode-go",
      anthropicModel,
      { type: "none" },
      false,
    );

    await expect(validateModelProviderSmoke({
      apiKey: "provider-secret",
      config,
      fetch: async (_input, init) => {
        requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        const response = responses.shift();
        if (!response) throw new Error("Unexpected smoke request");
        return response;
      },
      timeoutMs: 2_000,
    })).resolves.toBeUndefined();

    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      tool_choice: { name: "confirm_model_provider", type: "tool" },
    });
    expect(requests[1]).not.toHaveProperty("tool_choice");
    expect(requests[1]).not.toHaveProperty("tools");
  });

  it("uses automatic tool choice for the exact DeepSeek thinking handshake", async () => {
    const requests: Record<string, unknown>[] = [];
    const responses = [
      completion({
        content: null,
        reasoning_content: "The requested tool must be called.",
        role: "assistant",
        tool_calls: [{
          function: {
            arguments: JSON.stringify({ value: "OSINARA_MODEL_PROVIDER_SMOKE_READY" }),
            name: "confirm_model_provider",
          },
          id: "smoke-call-1",
          type: "function",
        }],
      }, "tool_calls"),
      completion({
        content: "OSINARA_MODEL_PROVIDER_SMOKE_OK",
        reasoning_content: "The tool result is accepted.",
        role: "assistant",
      }, "stop"),
    ];
    const deepSeekModel: ProviderCatalogModel = {
      ...model,
      displayName: "DeepSeek V4 Flash Vision Exp",
      id: "deepseek-v4-flash-vision-exp",
      reasoningOptions: [
        { type: "none" },
        { effort: "high", type: "effort" },
      ],
      supportsImageInput: true,
    };
    const config = buildModelProviderConfig(
      "deepseek",
      deepSeekModel,
      { effort: "high", type: "effort" },
      false,
    );

    await expect(validateModelProviderSmoke({
      apiKey: "provider-secret",
      config,
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        requests.push(body);
        if ("tool_choice" in body) {
          return new Response(JSON.stringify({
            error: {
              code: "invalid_request_error",
              message: "Thinking mode does not support this tool_choice",
              type: "invalid_request_error",
            },
          }), {
            headers: { "content-type": "application/json" },
            status: 400,
          });
        }
        const response = responses.shift();
        if (!response) throw new Error("Unexpected smoke request");
        return response;
      },
      timeoutMs: 2_000,
    })).resolves.toBeUndefined();

    expect(requests).toHaveLength(2);
    expect(requests).toEqual([
      expect.objectContaining({
        reasoning_effort: "high",
        thinking: { type: "enabled" },
      }),
      expect.objectContaining({
        reasoning_effort: "high",
        thinking: { type: "enabled" },
      }),
    ]);
  });

  it("rejects a response that does not end with the exact final text", async () => {
    const responses = [
      completion({
        content: null,
        role: "assistant",
        tool_calls: [{
          function: {
            arguments: JSON.stringify({ value: "OSINARA_MODEL_PROVIDER_SMOKE_READY" }),
            name: "confirm_model_provider",
          },
          id: "smoke-call-1",
          type: "function",
        }],
      }, "tool_calls"),
      completion({ content: "Almost ready", role: "assistant" }, "stop"),
    ];
    const config = buildModelProviderConfig("openrouter", model, { type: "none" }, false);

    await expect(validateModelProviderSmoke({
      apiKey: "provider-secret",
      config,
      fetch: async () => responses.shift()!,
      timeoutMs: 2_000,
    })).rejects.toThrow("AGENT_PROVIDER_SMOKE_RESPONSE_INVALID");
  });

  it.each([0, 30_001, 1.5])("rejects an unbounded timeout value %s", async (timeoutMs) => {
    const config = buildModelProviderConfig("openrouter", model, { type: "none" }, false);

    await expect(validateModelProviderSmoke({
      apiKey: "provider-secret",
      config,
      fetch: vi.fn(),
      timeoutMs,
    })).rejects.toThrow("AGENT_PROVIDER_SMOKE_TIMEOUT_INVALID");
  });
});
