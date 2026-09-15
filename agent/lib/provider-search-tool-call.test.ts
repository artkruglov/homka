/**
 * Provider search tool guard tests.
 *
 * Constructs covered:
 * - A `web_search` returned as a plain function call is re-labelled provider-executed and closed
 *   with an error result, in a non-streaming result and through the transport stream.
 * - A genuine provider-executed search call and ordinary function calls pass untouched.
 */
import type { LanguageModelV4CallOptions, LanguageModelV4Content, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createConfiguredLanguageModel } from "./model-transport.js";
import {
  closeStrayProviderSearchCalls,
  PROVIDER_SEARCH_FUNCTION_CALL_CODE,
} from "./provider-search-tool-call.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("closeStrayProviderSearchCalls", () => {
  it("closes only a search call that no local executor can answer", () => {
    const content: LanguageModelV4Content[] = [
      { input: "{}", toolCallId: "call_search", toolName: "web_search", type: "tool-call" },
      { input: "{}", providerExecuted: true, toolCallId: "ws_native", toolName: "web_search", type: "tool-call" },
      { input: "{\"pattern\":\"*\"}", toolCallId: "call_glob", toolName: "glob", type: "tool-call" },
    ];
    const stray: string[] = [];

    const closed = closeStrayProviderSearchCalls(content, (id) => stray.push(id));

    expect(stray).toEqual(["call_search"]);
    expect(closed).toEqual([
      { input: "{}", providerExecuted: true, toolCallId: "call_search", toolName: "web_search", type: "tool-call" },
      expect.objectContaining({ isError: true, toolCallId: "call_search", type: "tool-result" }),
      content[1],
      content[2],
    ]);
    expect(JSON.stringify(closed[1])).toContain(PROVIDER_SEARCH_FUNCTION_CALL_CODE);
  });
});

describe("transport stream", () => {
  it("closes a DeepSeek web_search function call before Eve stores it", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const events = [
      { type: "response.created", response: { id: "resp_1", created_at: 1, model: "deepseek-v4-flash", object: "response", output: [], status: "in_progress" } },
      { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_search", name: "web_search", arguments: "", status: "in_progress" } },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: "{}" },
      { type: "response.function_call_arguments.done", item_id: "fc_1", output_index: 0, arguments: "{}" },
      { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_search", name: "web_search", arguments: "{}", status: "completed" } },
      { type: "response.completed", response: {
        id: "resp_1", created_at: 1, model: "deepseek-v4-flash", object: "response", status: "completed",
        output: [{ type: "function_call", id: "fc_1", call_id: "call_search", name: "web_search", arguments: "{}", status: "completed" }],
        usage: { input_tokens: 20, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 25 },
      } },
    ];
    const model = createConfiguredLanguageModel({
      apiKey: "model-secret",
      fetch: async () => new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
        status: 200,
      }),
      maxOutputTokens: 8_000,
      modelId: "deepseek-v4-flash",
      transport: { baseUrl: "https://api.deepseek.com", protocol: "deepseek-responses", reasoning: { effort: "high" } },
    });

    const { stream } = await model.doStream({
      prompt: [{ content: [{ text: "Найди", type: "text" }], role: "user" }],
    } as LanguageModelV4CallOptions);
    const parts: LanguageModelV4StreamPart[] = [];
    for await (const part of stream) parts.push(part);

    const call = parts.find((part) => part.type === "tool-call");
    expect(call).toMatchObject({ providerExecuted: true, toolCallId: "call_search", toolName: "web_search" });
    const result = parts.find((part) => part.type === "tool-result");
    expect(result).toMatchObject({ isError: true, toolCallId: "call_search", toolName: "web_search" });
    expect(parts.findIndex((part) => part.type === "tool-result")).toBeGreaterThan(parts.findIndex((part) => part.type === "tool-call"));
    expect(parts.find((part) => part.type === "tool-input-start")).toMatchObject({ providerExecuted: true });
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining(PROVIDER_SEARCH_FUNCTION_CALL_CODE));
  });
});
