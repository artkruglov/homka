/**
 * MiniMax Anthropic Messages wire compatibility.
 *
 * Export:
 * - `createMiniMaxAnthropicCompatibilityFetch`: preserves MiniMax web-search result content while
 *   translating responses for the AI SDK and replaying results through ordinary tool messages.
 *
 * Key constructs:
 * - Exact block matching leaves ordinary model payloads untouched.
 * - Provider search history is downgraded because MiniMax rejects its own native result blocks.
 * - Streaming normalization buffers split SSE lines without buffering the complete response.
 */
import type { FetchFunction } from "@ai-sdk/provider-utils";

import { AppError } from "./app-error.js";

type WireDirection = "from-minimax" | "to-minimax";

const ANTHROPIC_WEB_SEARCH_CONTENT_FIELD = "encrypted_content";
const MAX_JSON_RESPONSE_BYTES = 2_000_000;
const MAX_SSE_LINE_CHARACTERS = 2_000_000;
const MINIMAX_WEB_SEARCH_CONTENT_FIELD = "content";
const WEB_SEARCH_RESULT_TYPE = "web_search_result";
const WEB_SEARCH_TOOL_RESULT_TYPE = "web_search_tool_result";

function parseWireJson(source: string): unknown {
  try {
    return JSON.parse(source);
  } catch (error) {
    // Preserve the parser error and stack while making provider-boundary failures diagnosable.
    if (error instanceof Error) {
      Object.defineProperty(error, "message", {
        configurable: true,
        value: `AGENT_MINIMAX_ANTHROPIC_PAYLOAD_INVALID: MiniMax передал некорректный JSON: ${error.message}`,
        writable: true,
      });
    }
    throw error;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function rewriteSearchResult(value: unknown, direction: WireDirection): unknown {
  const result = record(value);
  if (!result || result.type !== WEB_SEARCH_RESULT_TYPE) return value;

  const sourceField = direction === "from-minimax"
    ? MINIMAX_WEB_SEARCH_CONTENT_FIELD
    : ANTHROPIC_WEB_SEARCH_CONTENT_FIELD;
  const targetField = direction === "from-minimax"
    ? ANTHROPIC_WEB_SEARCH_CONTENT_FIELD
    : MINIMAX_WEB_SEARCH_CONTENT_FIELD;
  const source = result[sourceField];
  if (typeof source !== "string" || result[targetField] !== undefined) return value;

  // Move the exact opaque value rather than manufacturing an Anthropic encrypted payload.
  const rewritten = { ...result, [targetField]: source };
  delete rewritten[sourceField];
  return rewritten;
}

function isCompleteAnthropicSearchResult(value: unknown): boolean {
  const result = record(value);
  return result?.type === WEB_SEARCH_RESULT_TYPE &&
    typeof result.url === "string" &&
    typeof result.title === "string" &&
    typeof result[ANTHROPIC_WEB_SEARCH_CONTENT_FIELD] === "string";
}

function rewriteToolResultBlock(value: unknown, direction: WireDirection): unknown {
  const block = record(value);
  if (!block || block.type !== WEB_SEARCH_TOOL_RESULT_TYPE || !Array.isArray(block.content)) {
    return value;
  }
  const rewritten = block.content.map((result) => rewriteSearchResult(result, direction));
  return {
    ...block,
    // MiniMax sometimes emits URL-only entries, while Anthropic requires title, URL, and content.
    content: direction === "from-minimax"
      ? rewritten.filter(isCompleteAnthropicSearchResult)
      : rewritten,
  };
}

function replayableWebSearchIds(content: readonly unknown[]): ReadonlySet<string> {
  const callIds = new Set<string>();
  const resultIds = new Set<string>();
  for (const value of content) {
    const block = record(value);
    if (block?.type === "server_tool_use" && block.name === "web_search") {
      if (typeof block.id !== "string") {
        throw new AppError(
          "AGENT_MINIMAX_ANTHROPIC_HISTORY_INVALID",
          "История веб-поиска MiniMax содержит вызов без идентификатора",
        );
      }
      callIds.add(block.id);
    }
    if (block?.type === WEB_SEARCH_TOOL_RESULT_TYPE) {
      if (typeof block.tool_use_id !== "string") {
        throw new AppError(
          "AGENT_MINIMAX_ANTHROPIC_HISTORY_INVALID",
          "История веб-поиска MiniMax содержит результат без идентификатора вызова",
        );
      }
      resultIds.add(block.tool_use_id);
    }
  }
  const replayIds = new Set([...callIds].filter((id) => resultIds.has(id)));
  return replayIds;
}

function serializeReplayToolResult(content: unknown): string {
  // Ordinary tool output keeps the snippets model-visible without asking MiniMax to validate
  // the native provider-owned result block that its Anthropic endpoint cannot replay.
  const normalized = Array.isArray(content)
    ? content.map((result) => rewriteSearchResult(result, "to-minimax"))
    : content;
  const serialized = JSON.stringify(normalized);
  if (serialized !== undefined) return serialized;
  throw new AppError(
    "AGENT_MINIMAX_ANTHROPIC_HISTORY_INVALID",
    "История веб-поиска MiniMax содержит некорректный результат инструмента",
  );
}

function rewriteAssistantSearchHistory(message: Record<string, unknown>): Record<string, unknown>[] {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return [message];
  const replayIds = replayableWebSearchIds(message.content);

  const messages: Record<string, unknown>[] = [];
  let assistantContent: unknown[] = [];
  const flushAssistant = () => {
    if (assistantContent.length === 0) return;
    messages.push({ ...message, content: assistantContent });
    assistantContent = [];
  };

  // Split at every native result so each converted tool call has the required following user
  // result, while preserving later text and ordinary local tool calls in their original order.
  for (const value of message.content) {
    const block = record(value);
    if (block?.type === "server_tool_use" && block.name === "web_search") {
      // A failed provider stream may persist only one half of the native search exchange.
      // Omit that unusable trace; paired calls are replayed through ordinary tool messages.
      if (typeof block.id === "string" && replayIds.has(block.id)) {
        assistantContent.push({
          ...(block.cache_control === undefined ? {} : { cache_control: block.cache_control }),
          id: block.id,
          input: block.input,
          name: block.name,
          type: "tool_use",
        });
      }
      continue;
    }
    if (block?.type === WEB_SEARCH_TOOL_RESULT_TYPE) {
      if (typeof block.tool_use_id === "string" && replayIds.has(block.tool_use_id)) {
        flushAssistant();
        messages.push({
          content: [{
            ...(block.cache_control === undefined ? {} : { cache_control: block.cache_control }),
            content: serializeReplayToolResult(block.content),
            tool_use_id: block.tool_use_id,
            type: "tool_result",
          }],
          role: "user",
        });
      }
      continue;
    }
    assistantContent.push(value);
  }
  flushAssistant();
  return messages;
}

function appendOutgoingMessage(
  messages: Record<string, unknown>[],
  message: Record<string, unknown>,
): void {
  const previous = messages.at(-1);
  if (
    previous?.role === "user" && message.role === "user" &&
    Array.isArray(previous.content) && Array.isArray(message.content)
  ) {
    // A result at the end of an assistant turn and the next user prompt form one Anthropic user
    // message, with tool_result first as required by the wire protocol.
    messages[messages.length - 1] = {
      ...previous,
      content: [...previous.content, ...message.content],
    };
    return;
  }
  messages.push(message);
}

function rewriteIncomingPayload(value: unknown): unknown {
  const payload = record(value);
  if (!payload) return value;

  // Streaming content blocks and complete JSON messages expose results at different levels.
  if (payload.type === "content_block_start") {
    return { ...payload, content_block: rewriteToolResultBlock(payload.content_block, "from-minimax") };
  }
  if (Array.isArray(payload.content)) {
    return {
      ...payload,
      content: payload.content.map((block) => rewriteToolResultBlock(block, "from-minimax")),
    };
  }
  return value;
}

function rewriteOutgoingPayload(value: unknown): unknown {
  const payload = record(value);
  if (!payload || !Array.isArray(payload.messages)) return value;
  const messages: Record<string, unknown>[] = [];
  for (const messageValue of payload.messages) {
    const message = record(messageValue);
    if (!message) {
      throw new AppError(
        "AGENT_MINIMAX_ANTHROPIC_HISTORY_INVALID",
        "История сообщений MiniMax содержит некорректную запись",
      );
    }
    for (const rewritten of rewriteAssistantSearchHistory(message)) {
      appendOutgoingMessage(messages, rewritten);
    }
  }
  return {
    ...payload,
    messages,
  };
}

function requestUrl(input: Parameters<FetchFunction>[0]): URL {
  return new URL(input instanceof Request ? input.url : String(input));
}

function rewriteRequest(
  input: Parameters<FetchFunction>[0],
  init: Parameters<FetchFunction>[1],
): Parameters<FetchFunction>[1] {
  if (!requestUrl(input).pathname.endsWith("/messages") || typeof init?.body !== "string") {
    return init;
  }
  return { ...init, body: JSON.stringify(rewriteOutgoingPayload(parseWireJson(init.body))) };
}

function rewriteSseLine(line: string): string {
  const carriageReturn = line.endsWith("\r") ? "\r" : "";
  const content = carriageReturn ? line.slice(0, -1) : line;
  if (!content.startsWith("data:") || !content.includes(WEB_SEARCH_TOOL_RESULT_TYPE)) return line;
  const data = content.slice("data:".length).trimStart();
  if (!data || data === "[DONE]") return line;
  return `data: ${JSON.stringify(rewriteIncomingPayload(parseWireJson(data)))}${carriageReturn}`;
}

function assertSseLineBound(buffer: string): void {
  if (buffer.length <= MAX_SSE_LINE_CHARACTERS) return;
  throw new AppError(
    "AGENT_MINIMAX_ANTHROPIC_SSE_LIMIT_EXCEEDED",
    "MiniMax передал слишком большой потоковый блок ответа",
  );
}

function rewriteSseBody(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    flush(controller) {
      buffer += decoder.decode();
      if (buffer) {
        assertSseLineBound(buffer);
        controller.enqueue(encoder.encode(rewriteSseLine(buffer)));
      }
    },
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex);
        assertSseLineBound(line);
        buffer = buffer.slice(newlineIndex + 1);
        controller.enqueue(encoder.encode(`${rewriteSseLine(line)}\n`));
        newlineIndex = buffer.indexOf("\n");
      }
      assertSseLineBound(buffer);
    },
  }));
}

function rewrittenResponse(response: Response, body: BodyInit): Response {
  const headers = new Headers(response.headers);
  // Body bytes changed, so upstream compression and length metadata no longer describe them.
  headers.delete("content-encoding");
  headers.delete("content-length");
  return new Response(body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

async function readBoundedJsonBody(response: Response): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && /^\d+$/u.test(declaredLength)) {
    if (Number(declaredLength) > MAX_JSON_RESPONSE_BYTES) {
      throw new AppError(
        "AGENT_MINIMAX_ANTHROPIC_JSON_LIMIT_EXCEEDED",
        "MiniMax передал слишком большой JSON-ответ",
      );
    }
  }

  // Count bytes while decoding so a missing or dishonest Content-Length cannot exhaust memory.
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let source = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytesRead += chunk.value.byteLength;
    if (bytesRead > MAX_JSON_RESPONSE_BYTES) {
      await reader.cancel();
      throw new AppError(
        "AGENT_MINIMAX_ANTHROPIC_JSON_LIMIT_EXCEEDED",
        "MiniMax передал слишком большой JSON-ответ",
      );
    }
    source += decoder.decode(chunk.value, { stream: true });
  }
  return source + decoder.decode();
}

async function rewriteResponse(response: Response): Promise<Response> {
  if (!response.ok || response.body === null) return response;
  const contentType = response.headers.get("content-type")?.toLowerCase();
  if (contentType?.includes("text/event-stream")) {
    return rewrittenResponse(response, rewriteSseBody(response.body));
  }
  if (contentType?.includes("application/json")) {
    const payload = rewriteIncomingPayload(parseWireJson(await readBoundedJsonBody(response)));
    return rewrittenResponse(response, JSON.stringify(payload));
  }
  return response;
}

export function createMiniMaxAnthropicCompatibilityFetch(fetch: FetchFunction): FetchFunction {
  return async (input, init) => {
    const response = await fetch(input, rewriteRequest(input, init));
    return await rewriteResponse(response);
  };
}
