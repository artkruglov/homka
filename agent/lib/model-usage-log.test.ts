/**
 * Model usage observability tests.
 *
 * Constructs covered:
 * - Provider usage payloads normalize to one cache-aware shape across wire protocols.
 * - Streaming and JSON model responses emit exactly one structured usage log each.
 * - Eve `step.completed` events project session identity next to framework usage.
 */
import { generateText } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createConfiguredLanguageModel } from "./model-transport.js";
import {
  formatStepUsageLog,
  normalizeProviderUsage,
  observeModelUsage,
} from "./model-usage-log.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function sseResponse(lines: readonly string[]): Response {
  return new Response(lines.join("\n"), {
    headers: { "content-type": "text/event-stream" },
    status: 200,
  });
}

describe("normalizeProviderUsage", () => {
  it("maps DeepSeek chat-completions usage including cache hit and reasoning details", () => {
    expect(normalizeProviderUsage({
      completion_tokens: 40,
      completion_tokens_details: { reasoning_tokens: 25 },
      prompt_cache_hit_tokens: 900,
      prompt_cache_miss_tokens: 100,
      prompt_tokens: 1_000,
      total_tokens: 1_040,
    })).toEqual({
      cacheHitTokens: 900,
      cacheMissTokens: 100,
      completionTokens: 40,
      promptTokens: 1_000,
      reasoningTokens: 25,
    });
  });

  it("maps OpenAI-style cached_tokens when provider-specific cache fields are absent", () => {
    expect(normalizeProviderUsage({
      completion_tokens: 10,
      prompt_tokens: 500,
      prompt_tokens_details: { cached_tokens: 200 },
    })).toEqual({
      cacheHitTokens: 200,
      cacheMissTokens: 300,
      completionTokens: 10,
      promptTokens: 500,
      reasoningTokens: null,
    });
  });

  it("maps Anthropic Messages usage", () => {
    expect(normalizeProviderUsage({
      cache_creation_input_tokens: 50,
      cache_read_input_tokens: 700,
      input_tokens: 30,
      output_tokens: 12,
    })).toEqual({
      cacheHitTokens: 700,
      cacheMissTokens: 80,
      completionTokens: 12,
      promptTokens: 780,
      reasoningTokens: null,
    });
  });

  it("returns null for payloads without token counts", () => {
    expect(normalizeProviderUsage({ foo: 1 })).toBeNull();
    expect(normalizeProviderUsage(null)).toBeNull();
  });
});

describe("observeModelUsage", () => {
  it("observes Anthropic search, client tools and text without logging their contents or changing bytes", async () => {
    const log = vi.fn();
    const events = [
      { type: "message_start", message: { content: [], usage: { input_tokens: 10, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id: "s1", name: "web_search", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"query":"private-query"}' } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "web_search_tool_result", tool_use_id: "s1", content: [{ type: "web_search_result", url: "https://private.example", encrypted_content: "private-result" }] } },
      { type: "content_block_start", index: 2, content_block: { type: "server_tool_use", id: "s2", name: "web_search", input: {} } },
      { type: "content_block_start", index: 3, content_block: { type: "tool_use", id: "t1", name: "manage_errand", input: {} } },
      { type: "content_block_delta", index: 3, delta: { type: "input_json_delta", partial_json: '{"action":"list"}' } },
      { type: "content_block_start", index: 4, content_block: { type: "thinking", thinking: "private-thinking" } },
      { type: "content_block_delta", index: 4, delta: { type: "thinking_delta", thinking: "private-thinking" } },
      { type: "content_block_start", index: 5, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 5, delta: { type: "text_delta", text: "Готово" } },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 42 } },
      { type: "message_stop" },
    ];
    const bytes = new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""));
    // Split both SSE lines and UTF-8 characters across incoming chunks.
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 7) controller.enqueue(bytes.slice(offset, offset + 7));
      controller.close();
    } });
    const observed = observeModelUsage(new Response(body, { headers: { "content-type": "text/event-stream" } }),
      { modelId: "m", url: "https://example.test/anthropic/messages" }, log);
    expect(new Uint8Array(await observed.arrayBuffer())).toEqual(bytes);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({
      contentChars: 6, finishReason: "tool_use", webSearchCalls: 2, toolCalls: ["manage_errand"],
      promptTokens: 10, completionTokens: 42,
    });
    expect(log.mock.calls[0]![0]).not.toContain("private-");
  });

  it("observes a complete Anthropic message and excludes thinking and search results from visible text", async () => {
    const log = vi.fn();
    const body = JSON.stringify({ type: "message", stop_reason: "end_turn", usage: { input_tokens: 20, output_tokens: 8 }, content: [
      { type: "server_tool_use", name: "web_search", id: "s1", input: { query: "private-query" } },
      { type: "web_search_tool_result", tool_use_id: "s1", content: [{ type: "web_search_result", text: "private-result" }] },
      { type: "thinking", thinking: "private-thinking" },
      { type: "tool_use", name: "manage_errand", id: "t1", input: { action: "list" } },
      { type: "text", text: "Готово" },
    ] });
    const observed = observeModelUsage(new Response(body), { modelId: "m", url: "https://example.test/anthropic/messages" }, log);
    expect(await observed.text()).toBe(body);
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(1));
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({
      contentChars: 6, finishReason: "end_turn", webSearchCalls: 1, toolCalls: ["manage_errand"],
    });
    expect(log.mock.calls[0]![0]).not.toContain("private-");
  });

  it("logs once for a streaming response and passes the body through unchanged", async () => {
    const log = vi.fn();
    const lines = [
      'data: {"choices":[{"delta":{"content":"При"}}]}',
      "",
      'data: {"choices":[{"delta":{"content":"вет"},"finish_reason":"stop"}]}',
      "",
      'data: {"choices":[],"usage":{"prompt_tokens":100,"prompt_cache_hit_tokens":64,"prompt_cache_miss_tokens":36,"completion_tokens":2,"completion_tokens_details":{"reasoning_tokens":1}}}',
      "",
      "data: [DONE]",
      "",
    ];
    const observed = observeModelUsage(sseResponse(lines), { modelId: "deepseek-v4-flash", url: "https://api.deepseek.com/chat/completions" }, log);

    expect(await observed.text()).toBe(lines.join("\n"));
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual({
      cacheHitTokens: 64,
      cacheMissTokens: 36,
      code: "AGENT_MODEL_USAGE",
      completionTokens: 2,
      contentChars: 6,
      finishReason: "stop",
      modelId: "deepseek-v4-flash",
      promptTokens: 100,
      reasoningTokens: 1,
      toolCalls: [],
      webSearchCalls: 0,
      url: "https://api.deepseek.com/chat/completions",
    });
  });

  // Расход в долларах считается по разбивке кэша, которую видит только транспорт.
  it("hands the billed usage to the recorder once, and treats input without a cache split as missed", async () => {
    const onUsage = vi.fn();
    const lines = [
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}',
      'data: {"choices":[],"usage":{"prompt_tokens":100,"prompt_cache_hit_tokens":64,"prompt_cache_miss_tokens":36,"completion_tokens":2}}',
      "data: [DONE]",
    ];
    const observed = observeModelUsage(sseResponse(lines), { modelId: "deepseek-v4-flash", onUsage, url: "https://api.deepseek.com/chat/completions" }, vi.fn());
    await observed.text();
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage).toHaveBeenCalledWith({ cacheHitTokens: 64, cacheMissTokens: 36, modelId: "deepseek-v4-flash", outputTokens: 2, webSearchCalls: 0 });

    const plain = vi.fn();
    const json = observeModelUsage(new Response(JSON.stringify({ usage: { prompt_tokens: 50, completion_tokens: 5 } })), {
      modelId: "gpt", onUsage: plain, url: "https://example.test/v1/chat/completions",
    }, vi.fn());
    await json.text();
    await vi.waitFor(() => expect(plain).toHaveBeenCalledWith({ cacheHitTokens: 0, cacheMissTokens: 50, modelId: "gpt", outputTokens: 5, webSearchCalls: 0 }));
  });

  it("makes a reasoning-only reply visible: finish reason with zero content characters", async () => {
    const log = vi.fn();
    const lines = [
      'data: {"choices":[{"delta":{"reasoning":"думаю"}}]}',
      "",
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
      "",
      'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":4,"completion_tokens_details":{"reasoning_tokens":4}}}',
      "",
      "data: [DONE]",
      "",
    ];
    const observed = observeModelUsage(sseResponse(lines), { modelId: "qwen", url: "https://api.groq.com/openai/v1/chat/completions" }, log);

    await observed.text();
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({
      contentChars: 0,
      finishReason: "stop",
      reasoningTokens: 4,
    });
  });

  it("merges Anthropic message_start input usage with message_delta output usage", async () => {
    const log = vi.fn();
    const observed = observeModelUsage(
      sseResponse([
        'event: message_start',
        'data: {"type":"message_start","message":{"usage":{"input_tokens":30,"cache_read_input_tokens":700,"cache_creation_input_tokens":50,"output_tokens":1}}}',
        "",
        'event: message_delta',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}',
        "",
      ]),
      { modelId: "m", url: "https://example.test/anthropic/v1/messages" },
      log,
    );

    await observed.text();
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(1));
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({
      cacheHitTokens: 700,
      cacheMissTokens: 80,
      completionTokens: 42,
      promptTokens: 780,
    });
  });

  it("reads Responses API usage from the completed event and counts web searches", async () => {
    const log = vi.fn();
    const observed = observeModelUsage(
      sseResponse([
        'event: response.output_item.done',
        'data: {"type":"response.output_item.done","item":{"type":"web_search_call","status":"completed"}}',
        "",
        'event: response.web_search_call.completed',
        'data: {"type":"response.web_search_call.completed","item_id":"ws_1"}',
        "",
        'event: response.output_text.delta',
        'data: {"type":"response.output_text.delta","delta":"Погода +15"}',
        "",
        'event: response.completed',
        'data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"web_search_call","status":"completed"},{"type":"message","content":[{"type":"output_text","text":"Погода +15"}]}],"usage":{"input_tokens":3451,"input_tokens_details":{"cached_tokens":640},"output_tokens":204,"output_tokens_details":{"reasoning_tokens":85}}}}',
        "",
      ]),
      { modelId: "deepseek-v4-flash", url: "https://api.deepseek.com/responses" },
      log,
    );

    await observed.text();
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(1));
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({
      cacheHitTokens: 640,
      cacheMissTokens: 2811,
      completionTokens: 204,
      contentChars: 20,
      finishReason: "completed",
      promptTokens: 3451,
      reasoningTokens: 85,
      webSearchCalls: 1,
    });
  });

  it("logs once for a JSON response", async () => {
    const log = vi.fn();
    const body = JSON.stringify({ choices: [], usage: { completion_tokens: 3, prompt_tokens: 20 } });
    const observed = observeModelUsage(new Response(body, {
      headers: { "content-type": "application/json" },
      status: 200,
    }), { modelId: "m", url: "https://example.test/v1" }, log);

    expect(await observed.text()).toBe(body);
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(1));
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({
      code: "AGENT_MODEL_USAGE",
      completionTokens: 3,
      promptTokens: 20,
    });
  });

  it("does not log when the stream carries no usage", async () => {
    const log = vi.fn();
    const observed = observeModelUsage(
      sseResponse(['data: {"choices":[{"delta":{"content":"x"}}]}', "", "data: [DONE]", ""]),
      { modelId: "m", url: "https://example.test/v1" },
      log,
    );

    await observed.text();
    expect(log).not.toHaveBeenCalled();
  });

  it("leaves error responses untouched", async () => {
    const log = vi.fn();
    const observed = observeModelUsage(
      new Response('{"error":{"message":"bad"}}', { status: 500 }),
      { modelId: "m", url: "https://example.test/v1" },
      log,
    );

    expect(observed.status).toBe(500);
    await observed.text();
    expect(log).not.toHaveBeenCalled();
  });
});

describe("configured model transport usage logging", () => {
  it("emits one usage log for a DeepSeek chat-completions call", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      choices: [{
        finish_reason: "stop",
        index: 0,
        message: { content: "Готово", role: "assistant" },
      }],
      created: 1,
      id: "chatcmpl_1",
      model: "deepseek-v4-flash",
      object: "chat.completion",
      usage: {
        completion_tokens: 5,
        completion_tokens_details: { reasoning_tokens: 2 },
        prompt_cache_hit_tokens: 30,
        prompt_cache_miss_tokens: 12,
        prompt_tokens: 42,
      },
    }), { headers: { "content-type": "application/json" }, status: 200 }));
    const model = createConfiguredLanguageModel({
      apiKey: "model-secret",
      fetch,
      maxOutputTokens: 128_000,
      modelId: "deepseek-v4-flash",
      transport: {
        baseUrl: "https://api.deepseek.com",
        protocol: "openai-chat-completions",
        providerName: "deepseek",
        reasoning: { effort: "low", format: "deepseek", type: "effort" },
      },
    });

    await expect(generateText({ model, prompt: "Проверка" })).resolves.toMatchObject({ text: "Готово" });
    await vi.waitFor(() => expect(info).toHaveBeenCalledTimes(1));
    expect(JSON.parse(info.mock.calls[0]![0] as string)).toEqual({
      cacheHitTokens: 30,
      cacheMissTokens: 12,
      code: "AGENT_MODEL_USAGE",
      completionTokens: 5,
      contentChars: 6,
      finishReason: "stop",
      modelId: "deepseek-v4-flash",
      promptTokens: 42,
      reasoningTokens: 2,
      toolCalls: [],
      webSearchCalls: 0,
      url: "https://api.deepseek.com/chat/completions",
    });
  });
});

describe("formatStepUsageLog", () => {
  it("projects session identity and framework usage from a step.completed event", () => {
    expect(JSON.parse(formatStepUsageLog({
      data: {
        finishReason: "tool-calls",
        sequence: 7,
        stepIndex: 3,
        turnId: "turn_1",
        usage: { cacheReadTokens: 10, inputTokens: 120, outputTokens: 8 },
      },
      type: "step.completed",
    }, { channelKind: "telegram", sessionId: "session_1" }))).toEqual({
      cacheReadTokens: 10,
      channelKind: "telegram",
      code: "AGENT_MODEL_STEP",
      finishReason: "tool-calls",
      inputTokens: 120,
      outputTokens: 8,
      sessionId: "session_1",
      stepIndex: 3,
      turnId: "turn_1",
    });
  });
});
