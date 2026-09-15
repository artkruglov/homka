/**
 * Model usage observability.
 *
 * Exports:
 * - `NormalizedProviderUsage`: cache-aware token counts shared by every wire protocol.
 * - `normalizeProviderUsage`: maps OpenAI Chat Completions, DeepSeek, and Anthropic usage.
 * - `observeModelUsage`: logs the provider-reported usage of one model response and hands the billed
 *   counts to an optional recorder.
 * - `formatStepUsageLog`: projects Eve `step.completed` usage next to session identity.
 *
 * Key constructs:
 * - DeepSeek reports cache hits only in provider-specific fields the AI SDK does not surface, so
 *   the raw response is observed at the transport boundary instead of Eve's framework usage.
 * - Streaming bodies pass through byte-for-byte; the observer only reads copied text lines.
 */
export interface NormalizedProviderUsage {
  readonly cacheHitTokens: number | null;
  readonly cacheMissTokens: number | null;
  readonly completionTokens: number | null;
  readonly promptTokens: number | null;
  readonly reasoningTokens: number | null;
}

/** Finish reason and visible content size: a reasoning-only reply shows up as zero characters. */
interface ResponseShape {
  contentChars: number;
  finishReason: string | null;
  toolCalls: string[];
  webSearchCalls: number;
}

/** Billed counts of one response; input without a provider cache split counts as missed. */
export interface BilledModelUsage {
  readonly cacheHitTokens: number;
  readonly cacheMissTokens: number;
  readonly modelId: string;
  readonly outputTokens: number;
  readonly webSearchCalls: number;
}

export interface ModelUsageLogContext {
  readonly modelId: string;
  readonly onUsage?: (usage: BilledModelUsage) => void;
  readonly url: string;
}

export type UsageLogger = (line: string) => void;

const SSE_DATA_PREFIX = "data:";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A later partial usage record (Anthropic message_delta) keeps earlier prompt-side counts. */
function mergeUsage(
  previous: NormalizedProviderUsage | null,
  next: NormalizedProviderUsage | null,
): NormalizedProviderUsage | null {
  if (next === null) return previous;
  if (previous === null) return next;
  return {
    cacheHitTokens: next.cacheHitTokens || previous.cacheHitTokens,
    cacheMissTokens: next.cacheMissTokens || previous.cacheMissTokens,
    completionTokens: next.completionTokens ?? previous.completionTokens,
    promptTokens: next.promptTokens || previous.promptTokens,
    reasoningTokens: next.reasoningTokens ?? previous.reasoningTokens,
  };
}

export function normalizeProviderUsage(usage: unknown): NormalizedProviderUsage | null {
  if (!isRecord(usage)) return null;

  // DeepSeek / OpenAI Responses: input_tokens with cached detail, output_tokens with reasoning detail.
  const inputDetails = isRecord(usage.input_tokens_details) ? usage.input_tokens_details : null;
  const outputDetails = isRecord(usage.output_tokens_details) ? usage.output_tokens_details : null;
  const responsesInput = count(usage.input_tokens);
  if (responsesInput !== null && (inputDetails !== null || outputDetails !== null)) {
    const cached = count(inputDetails?.cached_tokens) ?? 0;
    return {
      cacheHitTokens: cached,
      cacheMissTokens: Math.max(0, responsesInput - cached),
      completionTokens: count(usage.output_tokens),
      promptTokens: responsesInput,
      reasoningTokens: count(outputDetails?.reasoning_tokens),
    };
  }

  const anthropicInput = count(usage.input_tokens);
  if (anthropicInput !== null) {
    const cacheRead = count(usage.cache_read_input_tokens) ?? 0;
    const cacheWrite = count(usage.cache_creation_input_tokens) ?? 0;
    return {
      cacheHitTokens: cacheRead,
      cacheMissTokens: anthropicInput + cacheWrite,
      completionTokens: count(usage.output_tokens),
      promptTokens: anthropicInput + cacheRead + cacheWrite,
      reasoningTokens: null,
    };
  }

  // Anthropic message_delta carries only the final output count; prompt-side counts arrive earlier.
  const anthropicOutput = count(usage.output_tokens);
  if (anthropicOutput !== null) {
    return {
      cacheHitTokens: 0,
      cacheMissTokens: 0,
      completionTokens: anthropicOutput,
      promptTokens: 0,
      reasoningTokens: null,
    };
  }

  const promptTokens = count(usage.prompt_tokens);
  const completionTokens = count(usage.completion_tokens);
  if (promptTokens === null && completionTokens === null) return null;

  const promptDetails = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {};
  const completionDetails = isRecord(usage.completion_tokens_details)
    ? usage.completion_tokens_details
    : {};
  const cacheHitTokens = count(usage.prompt_cache_hit_tokens) ?? count(promptDetails.cached_tokens);
  const cacheMissTokens = count(usage.prompt_cache_miss_tokens) ??
    (cacheHitTokens !== null && promptTokens !== null ? promptTokens - cacheHitTokens : null);
  return {
    cacheHitTokens,
    cacheMissTokens,
    completionTokens,
    promptTokens,
    reasoningTokens: count(completionDetails.reasoning_tokens),
  };
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Count only authored text and call descriptors, never tool inputs/results or thinking. */
function observeAnthropicBlock(block: unknown, shape: ResponseShape): void {
  if (!isRecord(block)) return;
  if (block.type === "text" && typeof block.text === "string") shape.contentChars += block.text.length;
  if (block.type === "tool_use" && typeof block.name === "string") shape.toolCalls.push(block.name);
  if (block.type === "server_tool_use" && block.name === "web_search") shape.webSearchCalls += 1;
}

/** Reads finish reason, visible text length and tool names across supported wire protocols. */
function observeChoices(payload: Record<string, unknown>, shape: ResponseShape): void {
  // Anthropic Messages reports a call once at block start; JSON deltas and results do not
  // represent additional calls. message_delta supplies the final provider stop reason.
  if (payload.type === "message" && Array.isArray(payload.content)) {
    for (const block of payload.content) observeAnthropicBlock(block, shape);
    if (typeof payload.stop_reason === "string") shape.finishReason = payload.stop_reason;
  }
  if (payload.type === "content_block_start") observeAnthropicBlock(payload.content_block, shape);
  if (payload.type === "content_block_delta" && isRecord(payload.delta) &&
      payload.delta.type === "text_delta" && typeof payload.delta.text === "string") {
    shape.contentChars += payload.delta.text.length;
  }
  if (payload.type === "message_delta" && isRecord(payload.delta) &&
      typeof payload.delta.stop_reason === "string") shape.finishReason = payload.delta.stop_reason;

  // Responses API: streamed text deltas and the terminal response status.
  if (payload.type === "response.output_text.delta" && typeof payload.delta === "string") {
    shape.contentChars += payload.delta.length;
  }
  if (typeof payload.type === "string" && /^response\.(completed|incomplete|failed)$/u.test(payload.type)) {
    shape.finishReason = payload.type.slice("response.".length);
  }
  // Streamed Responses items: function calls by name, so a turn's tool choice is visible in the log.
  if (payload.type === "response.output_item.done" && isRecord(payload.item)) {
    const item = payload.item;
    if (item.type === "function_call" && typeof item.name === "string") shape.toolCalls.push(item.name);
    if (item.type === "web_search_call") shape.webSearchCalls += 1;
  }
  // A streamed completion nests the final response; a JSON reply carries it at the top level.
  const finalResponse = isRecord(payload.response) && Array.isArray(payload.response.output)
    ? payload.response
    : payload;
  if (typeof finalResponse.status === "string" && Array.isArray(finalResponse.output)) {
    shape.finishReason = finalResponse.status;
    // The completed event repeats every item; streamed counts above already covered them.
    const streamed = shape.webSearchCalls > 0 || shape.toolCalls.length > 0;
    for (const item of finalResponse.output) {
      if (!isRecord(item)) continue;
      if (!streamed && item.type === "web_search_call") shape.webSearchCalls += 1;
      if (!streamed && item.type === "function_call" && typeof item.name === "string") shape.toolCalls.push(item.name);
      if (item.type === "message" && Array.isArray(item.content)) {
        for (const part of item.content) {
          if (isRecord(part) && typeof part.text === "string") shape.contentChars += part.text.length;
        }
      }
    }
  }
  if (!Array.isArray(payload.choices)) return;
  for (const choice of payload.choices) {
    if (!isRecord(choice)) continue;
    if (typeof choice.finish_reason === "string") shape.finishReason = choice.finish_reason;
    const part = isRecord(choice.delta) ? choice.delta : isRecord(choice.message) ? choice.message : null;
    if (part && typeof part.content === "string") shape.contentChars += part.content.length;
  }
}

function sseDataPayload(line: string): Record<string, unknown> | null {
  if (!line.startsWith(SSE_DATA_PREFIX)) return null;
  const payload = line.slice(SSE_DATA_PREFIX.length).trim();
  if (payload.length === 0 || payload === "[DONE]") return null;
  return parseJson(payload);
}

function emit(
  log: UsageLogger,
  context: ModelUsageLogContext,
  usage: NormalizedProviderUsage,
  shape: ResponseShape,
): void {
  log(JSON.stringify({
    code: "AGENT_MODEL_USAGE",
    modelId: context.modelId,
    url: context.url,
    ...usage,
    ...shape,
  }));
  if (context.onUsage) {
    const cacheHitTokens = usage.cacheHitTokens ?? 0;
    context.onUsage({
      cacheHitTokens,
      cacheMissTokens: usage.cacheMissTokens ?? Math.max(0, (usage.promptTokens ?? 0) - cacheHitTokens),
      modelId: context.modelId,
      outputTokens: usage.completionTokens ?? 0,
      webSearchCalls: shape.webSearchCalls,
    });
  }
}

function observeStream(
  body: ReadableStream<Uint8Array>,
  context: ModelUsageLogContext,
  log: UsageLogger,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let pending = "";
  // Streaming providers report usage in one late chunk; the last observed value wins.
  let usage: NormalizedProviderUsage | null = null;
  const shape: ResponseShape = { contentChars: 0, finishReason: null, toolCalls: [], webSearchCalls: 0 };
  const consume = (text: string, flush: boolean): void => {
    pending += text;
    const lines = pending.split(/\r?\n/u);
    pending = flush ? "" : (lines.pop() ?? "");
    for (const line of lines) {
      const payload = sseDataPayload(line);
      if (payload === null) continue;
      observeChoices(payload, shape);
      // Anthropic streams input usage inside message_start.message and output usage in message_delta.
      const nested = isRecord(payload.message)
        ? payload.message.usage
        : isRecord(payload.response) ? payload.response.usage : undefined;
      usage = mergeUsage(usage, normalizeProviderUsage(payload.usage) ?? normalizeProviderUsage(nested));

    }
  };
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    flush() {
      consume(decoder.decode(), true);
      if (usage !== null) emit(log, context, usage, shape);
    },
    transform(chunk, controller) {
      controller.enqueue(chunk);
      consume(decoder.decode(chunk, { stream: true }), false);
    },
  }));
}

export function observeModelUsage(
  response: Response,
  context: ModelUsageLogContext,
  log: UsageLogger = (line) => console.info(line),
): Response {
  if (!response.ok || response.body === null) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    return new Response(observeStream(response.body, context, log), {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    });
  }
  // Usage is read from a copy so the caller's body stream stays untouched.
  void response.clone().text().then((text) => {
    const payload = parseJson(text);
    if (payload === null) return;
    const usage = normalizeProviderUsage(payload.usage);
    if (usage === null) return;
    const shape: ResponseShape = { contentChars: 0, finishReason: null, toolCalls: [], webSearchCalls: 0 };
    observeChoices(payload, shape);
    emit(log, context, usage, shape);
  }).catch(() => undefined);
  return response;
}

export interface StepUsageEvent {
  readonly data: {
    readonly finishReason: string;
    readonly sequence?: number;
    readonly stepIndex: number;
    readonly turnId: string;
    readonly usage?: {
      readonly cacheReadTokens?: number;
      readonly costUsd?: number;
      readonly inputTokens?: number;
      readonly outputTokens?: number;
    };
  };
  readonly type: "step.completed";
}

export function formatStepUsageLog(
  event: StepUsageEvent,
  session: { readonly channelKind: string | undefined; readonly sessionId: string },
): string {
  const usage = event.data.usage ?? {};
  return JSON.stringify({
    code: "AGENT_MODEL_STEP",
    channelKind: session.channelKind ?? null,
    finishReason: event.data.finishReason,
    sessionId: session.sessionId,
    stepIndex: event.data.stepIndex,
    turnId: event.data.turnId,
    ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
    ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
    ...(usage.costUsd === undefined ? {} : { costUsd: usage.costUsd }),
  });
}
