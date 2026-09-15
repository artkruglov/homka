/**
 * MiniMax Anthropic wire-compatibility tests.
 *
 * Constructs covered:
 * - `createMiniMaxAnthropicCompatibilityFetch`: preserves MiniMax web-search payload bytes.
 * - Chunked SSE records are normalized without changing unrelated provider events.
 * - Incomplete MiniMax search entries are removed before Anthropic schema validation.
 * - JSON responses use the same narrow web-search result normalization.
 * - Provider-managed search history is replayed through MiniMax-safe ordinary tool messages.
 * - The configured AI SDK transport consumes MiniMax provider-managed search across model steps.
 * - Malformed provider JSON fails with a stable boundary error.
 * - Oversized non-streaming responses are rejected before body buffering.
 */
import { anthropic } from "@ai-sdk/anthropic";
import type { FetchFunction } from "@ai-sdk/provider-utils";
import { generateText, stepCountIs, streamText, tool } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createConfiguredLanguageModel } from "./model-transport.js";
import { createMiniMaxAnthropicCompatibilityFetch } from "./minimax-anthropic-compatibility.js";

const RESULT = {
  content: "Проверенный фрагмент страницы",
  title: "Доставка еды",
  type: "web_search_result",
  url: "https://example.com/delivery",
};

function chunkedResponse(source: string, splitAt: number): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(source.slice(0, splitAt)));
      controller.enqueue(encoder.encode(source.slice(splitAt)));
      controller.close();
    },
  }), {
    headers: { "content-type": "text/event-stream" },
    status: 200,
  });
}

function event(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

describe("createMiniMaxAnthropicCompatibilityFetch", () => {
  it("normalizes a chunked MiniMax web-search SSE result for the Anthropic SDK", async () => {
    const event = {
      content_block: {
        content: [RESULT],
        tool_use_id: "call-search-1",
        type: "web_search_tool_result",
      },
      index: 3,
      type: "content_block_start",
    };
    const source = `event: content_block_start\ndata: ${JSON.stringify(event)}\n\nevent: ping\ndata: {"type":"ping"}\n\n`;
    const fetch = createMiniMaxAnthropicCompatibilityFetch(
      vi.fn(async () => chunkedResponse(source, 47)) as FetchFunction,
    );

    const response = await fetch("https://api.minimax.io/anthropic/v1/messages", {
      body: "{}",
      method: "POST",
    });
    const normalized = await response.text();

    expect(normalized).toContain(`"encrypted_content":"${RESULT.content}"`);
    expect(normalized).not.toContain(`"content":"${RESULT.content}"`);
    expect(normalized).toContain('data: {"type":"ping"}');
  });

  it("drops a search result that has no provider content instead of failing the complete stream", async () => {
    const incomplete = {
      title: "Instagram result without a snippet",
      type: "web_search_result",
      url: "https://www.instagram.com/example/",
    };
    const source = event("content_block_start", {
      content_block: {
        content: [RESULT, incomplete],
        tool_use_id: "call-search-1",
        type: "web_search_tool_result",
      },
      index: 1,
      type: "content_block_start",
    });
    const fetch = createMiniMaxAnthropicCompatibilityFetch(
      vi.fn(async () => chunkedResponse(source, 53)) as FetchFunction,
    );

    const response = await fetch("https://api.minimax.io/anthropic/v1/messages", {
      body: "{}",
      method: "POST",
    });
    const normalized = await response.text();

    expect(normalized).toContain(`"encrypted_content":"${RESULT.content}"`);
    expect(normalized).not.toContain(incomplete.url);
  });

  it("rejects malformed MiniMax search SSE with a stable error", async () => {
    const source = "event: content_block_start\ndata: {\"type\":\"web_search_tool_result\"\n\n";
    const fetch = createMiniMaxAnthropicCompatibilityFetch(
      vi.fn(async () => chunkedResponse(source, 20)) as FetchFunction,
    );
    const response = await fetch("https://api.minimax.io/anthropic/v1/messages", {
      body: "{}",
      method: "POST",
    });

    await expect(response.text()).rejects.toThrow(
      "AGENT_MINIMAX_ANTHROPIC_PAYLOAD_INVALID: MiniMax передал некорректный JSON",
    );
  });

  it("rewrites MiniMax web-search history as a replay-safe ordinary tool exchange", async () => {
    let body: unknown;
    const fetch = createMiniMaxAnthropicCompatibilityFetch(vi.fn(async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return new Response("{}", {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    }) as FetchFunction);

    await fetch("https://api.minimax.io/anthropic/v1/messages", {
      body: JSON.stringify({
        messages: [
          { content: [{ text: "Ищу.", type: "text" }], role: "assistant" },
          {
            content: [
              {
                id: "call-search-1",
                input: { query: "доставка еды" },
                name: "web_search",
                type: "server_tool_use",
              },
              {
                content: [{
                  encrypted_content: RESULT.content,
                  title: RESULT.title,
                  type: RESULT.type,
                  url: RESULT.url,
                }],
                tool_use_id: "call-search-1",
                type: "web_search_tool_result",
              },
              {
                id: "call-fetch-1",
                input: { url: RESULT.url },
                name: "web_fetch",
                type: "tool_use",
              },
            ],
            role: "assistant",
          },
          {
            content: [{ content: "Страница", tool_use_id: "call-fetch-1", type: "tool_result" }],
            role: "user",
          },
        ],
      }),
      method: "POST",
    });

    expect(body).toEqual({
      messages: [
        { content: [{ text: "Ищу.", type: "text" }], role: "assistant" },
        {
          content: [{
            id: "call-search-1",
            input: { query: "доставка еды" },
            name: "web_search",
            type: "tool_use",
          }],
          role: "assistant",
        },
        {
          content: [{
            content: JSON.stringify([{
              title: RESULT.title,
              type: RESULT.type,
              url: RESULT.url,
              content: RESULT.content,
            }]),
            tool_use_id: "call-search-1",
            type: "tool_result",
          }],
          role: "user",
        },
        {
          content: [{
            id: "call-fetch-1",
            input: { url: RESULT.url },
            name: "web_fetch",
            type: "tool_use",
          }],
          role: "assistant",
        },
        {
          content: [{ content: "Страница", tool_use_id: "call-fetch-1", type: "tool_result" }],
          role: "user",
        },
      ],
    });
  });

  it("removes unpaired native web-search history before calling MiniMax", async () => {
    let body: unknown;
    const upstream = vi.fn(async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return new Response("{}", {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    });
    const fetch = createMiniMaxAnthropicCompatibilityFetch(upstream as FetchFunction);

    await fetch("https://api.minimax.io/anthropic/v1/messages", {
      body: JSON.stringify({
        messages: [
          {
            content: [
              { text: "Проверяю.", type: "text" },
              {
                id: "call-search-without-result",
                input: { query: "доставка еды" },
                name: "web_search",
                type: "server_tool_use",
              },
              {
                content: [{
                  encrypted_content: RESULT.content,
                  title: RESULT.title,
                  type: RESULT.type,
                  url: RESULT.url,
                }],
                tool_use_id: "call-search-without-call",
                type: "web_search_tool_result",
              },
            ],
            role: "assistant",
          },
          { content: [{ text: "Продолжай.", type: "text" }], role: "user" },
        ],
      }),
      method: "POST",
    });

    expect(body).toEqual({
      messages: [
        { content: [{ text: "Проверяю.", type: "text" }], role: "assistant" },
        { content: [{ text: "Продолжай.", type: "text" }], role: "user" },
      ],
    });
  });

  it("normalizes non-streaming MiniMax message content", async () => {
    const fetch = createMiniMaxAnthropicCompatibilityFetch(vi.fn(async () =>
      new Response(JSON.stringify({
        content: [{
          content: [RESULT],
          tool_use_id: "call-search-1",
          type: "web_search_tool_result",
        }],
        type: "message",
      }), {
        headers: { "content-type": "application/json" },
        status: 200,
      })) as FetchFunction);

    const response = await fetch("https://api.minimax.io/anthropic/v1/messages", {
      body: "{}",
      method: "POST",
    });

    await expect(response.json()).resolves.toMatchObject({
      content: [{
        content: [{ encrypted_content: RESULT.content }],
        type: "web_search_tool_result",
      }],
    });
  });

  it("rejects an oversized declared JSON response before buffering", async () => {
    const fetch = createMiniMaxAnthropicCompatibilityFetch(vi.fn(async () =>
      new Response("{}", {
        headers: {
          "content-length": "2000001",
          "content-type": "application/json",
        },
        status: 200,
      })) as FetchFunction);

    await expect(fetch("https://api.minimax.io/anthropic/v1/messages", {
      body: "{}",
      method: "POST",
    })).rejects.toThrow("AGENT_MINIMAX_ANTHROPIC_JSON_LIMIT_EXCEEDED");
  });

  it("lets the AI SDK consume MiniMax web search followed by final text", async () => {
    const source = [
      event("message_start", {
        message: {
          content: [],
          id: "message-search-1",
          model: "MiniMax-M3",
          role: "assistant",
          stop_reason: null,
          stop_sequence: null,
          type: "message",
          usage: { input_tokens: 10, output_tokens: 0 },
        },
        type: "message_start",
      }),
      event("content_block_start", {
        content_block: {
          id: "call-search-1",
          input: { query: "доставка еды" },
          name: "web_search",
          type: "server_tool_use",
        },
        index: 0,
        type: "content_block_start",
      }),
      event("content_block_stop", { index: 0, type: "content_block_stop" }),
      event("content_block_start", {
        content_block: {
          content: [RESULT],
          tool_use_id: "call-search-1",
          type: "web_search_tool_result",
        },
        index: 1,
        type: "content_block_start",
      }),
      event("content_block_stop", { index: 1, type: "content_block_stop" }),
      event("content_block_start", {
        content_block: { text: "", type: "text" },
        index: 2,
        type: "content_block_start",
      }),
      event("content_block_delta", {
        delta: { text: "Нашла доставку.", type: "text_delta" },
        index: 2,
        type: "content_block_delta",
      }),
      event("content_block_stop", { index: 2, type: "content_block_stop" }),
      event("message_delta", {
        delta: { stop_reason: "end_turn", stop_sequence: null },
        type: "message_delta",
        usage: { input_tokens: 10, output_tokens: 8 },
      }),
      event("message_stop", { type: "message_stop" }),
    ].join("");
    const model = createConfiguredLanguageModel({
      apiKey: "model-secret",
      fetch: vi.fn(async () => chunkedResponse(source, 137)) as FetchFunction,
      maxOutputTokens: 128_000,
      modelId: "MiniMax-M3",
      transport: {
        authentication: "bearer",
        baseUrl: "https://api.minimax.io/anthropic/v1",
        compatibility: "minimax-anthropic",
        protocol: "anthropic-messages",
        reasoning: { mode: "adaptive", type: "enabled" },
      },
    });

    const result = streamText({
      maxRetries: 0,
      model,
      prompt: "Найди доставку еды",
      // The provider package and root AI SDK resolve separate branded tool schema instances.
      tools: { web_search: anthropic.tools.webSearch_20250305() as never },
    });

    await expect(result.text).resolves.toBe("Нашла доставку.");
    await expect(result.sources).resolves.toEqual([
      expect.objectContaining({ title: RESULT.title, url: RESULT.url }),
    ]);
  });

  it("lets the AI SDK continue after MiniMax search and a local tool result", async () => {
    const requests: unknown[] = [];
    const fetch = vi.fn(async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)));
      const firstCall = requests.length === 1;
      return new Response(JSON.stringify(firstCall
        ? {
            content: [
              {
                id: "call-search-1",
                input: { query: "доставка еды" },
                name: "web_search",
                type: "server_tool_use",
              },
              {
                content: [RESULT],
                tool_use_id: "call-search-1",
                type: "web_search_tool_result",
              },
              {
                id: "call-fetch-1",
                input: { url: RESULT.url },
                name: "web_fetch",
                type: "tool_use",
              },
            ],
            id: "message-search-1",
            model: "MiniMax-M3",
            role: "assistant",
            stop_reason: "tool_use",
            stop_sequence: null,
            type: "message",
            usage: { input_tokens: 10, output_tokens: 8 },
          }
        : {
            content: [{ text: "Проверка завершена.", type: "text" }],
            id: "message-search-2",
            model: "MiniMax-M3",
            role: "assistant",
            stop_reason: "end_turn",
            stop_sequence: null,
            type: "message",
            usage: { input_tokens: 20, output_tokens: 6 },
          }), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    }) as FetchFunction;
    const model = createConfiguredLanguageModel({
      apiKey: "model-secret",
      fetch,
      maxOutputTokens: 128_000,
      modelId: "MiniMax-M3",
      transport: {
        authentication: "bearer",
        baseUrl: "https://api.minimax.io/anthropic/v1",
        compatibility: "minimax-anthropic",
        protocol: "anthropic-messages",
        reasoning: { mode: "adaptive", type: "enabled" },
      },
    });

    const result = await generateText({
      model,
      prompt: "Найди и проверь доставку еды",
      stopWhen: stepCountIs(2),
      tools: {
        web_fetch: tool({
          execute: async () => ({ content: "Страница доставки" }),
          inputSchema: z.object({ url: z.url() }),
        }),
        // The provider package and root AI SDK resolve separate branded tool schema instances.
        web_search: anthropic.tools.webSearch_20250305() as never,
      },
    });

    expect(result.text).toBe("Проверка завершена.");
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({
      messages: expect.arrayContaining([
        {
          content: [expect.objectContaining({
            id: "call-search-1",
            name: "web_search",
            type: "tool_use",
          })],
          role: "assistant",
        },
        {
          content: [expect.objectContaining({
            tool_use_id: "call-search-1",
            type: "tool_result",
          })],
          role: "user",
        },
      ]),
    });
  });
});
