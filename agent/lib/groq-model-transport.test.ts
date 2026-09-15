/**
 * Groq Qwen transport contract tests.
 *
 * Constructs covered:
 * - Groq's native AI SDK adapter receives parsed low-effort reasoning on every request.
 * - Unsupported parallel tool calls stay disabled.
 * - Parsed reasoning remains separate and survives the tool-result continuation.
 */
import { generateText, stepCountIs, tool } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createConfiguredLanguageModel } from "./model-transport.js";

function completion(message: Record<string, unknown>, finishReason: string): Response {
  return new Response(JSON.stringify({
    choices: [{ finish_reason: finishReason, index: 0, message }],
    created: 1,
    id: "groq-completion",
    model: "qwen/qwen3.8-27b",
    object: "chat.completion",
    usage: { completion_tokens: 10, prompt_tokens: 20, total_tokens: 30 },
  }), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}

describe("Groq model transport", () => {
  it("uses parsed low reasoning through a complete serial tool turn", async () => {
    const requests: Array<{
      body: Record<string, unknown>;
      headers: Headers;
      url: string;
    }> = [];
    const responses = [
      completion({
        content: null,
        reasoning: "Нужно получить время.",
        tool_calls: [{
          function: { arguments: "{}", name: "get_time" },
          id: "call_time_001",
          type: "function",
        }],
      }, "tool_calls"),
      completion({
        content: "Сейчас 12:00.",
        reasoning: "Инструмент вернул точное время.",
      }, "stop"),
    ];
    const model = createConfiguredLanguageModel({
      apiKey: "groq-secret",
      fetch: async (input, init) => {
        requests.push({
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
          headers: new Headers(init?.headers),
          url: String(input),
        });
        const response = responses.shift();
        if (!response) throw new Error("Unexpected Groq request");
        return response;
      },
      maxOutputTokens: 16_384,
      modelId: "qwen/qwen3.8-27b",
      transport: {
        baseUrl: "https://api.groq.com/openai/v1",
        protocol: "openai-chat-completions",
        providerName: "groq",
        reasoning: { effort: "low", format: "reasoning-effort", type: "effort" },
      },
    });

    const result = await generateText({
      maxRetries: 0,
      model,
      prompt: "Который час?",
      stopWhen: stepCountIs(2),
      tools: {
        get_time: tool({
          execute: async () => ({ time: "12:00" }),
          inputSchema: z.object({}),
        }),
      },
    });

    expect(result.text).toBe("Сейчас 12:00.");
    expect(model.provider).toBe("groq.chat");
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      body: {
        max_tokens: 16_384,
        model: "qwen/qwen3.8-27b",
        parallel_tool_calls: false,
        reasoning_effort: "low",
        reasoning_format: "parsed",
      },
      url: "https://api.groq.com/openai/v1/chat/completions",
    });
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer groq-secret");
    expect(requests[1]?.body).toMatchObject({
      parallel_tool_calls: false,
      reasoning_effort: "low",
      reasoning_format: "parsed",
    });
    expect(requests[1]?.body.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        reasoning: "Нужно получить время.",
        role: "assistant",
        tool_calls: [expect.objectContaining({ id: "call_time_001" })],
      }),
      expect.objectContaining({ role: "tool", tool_call_id: "call_time_001" }),
    ]));
  });
});
