/**
 * Protocol-native AI SDK model factory.
 *
 * Exports:
 * - `ConfiguredLanguageModelOptions`: explicit model, secret, transport, and test fetch inputs.
 * - `createConfiguredLanguageModel`: creates a standard AI SDK model by wire protocol.
 *
 * Key constructs:
 * - Anthropic Messages adaptive thinking is enforced at the transport boundary.
 * - Explicit MiniMax compatibility preserves provider web-search payloads across Anthropic parsing.
 * - Retryable physical provider responses are logged before AI SDK applies its bounded retry policy.
 * - OpenAI Chat Completions carries explicit provider-native thinking controls when configured.
 */
import { deepSeekAnthropicSearchFetch } from "./deepseek/deepseek-anthropic-search.js";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGroq } from "@ai-sdk/groq";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type {
  LanguageModelV4FinishReason,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
  SharedV4ProviderOptions,
} from "@ai-sdk/provider";
import type { FetchFunction } from "@ai-sdk/provider-utils";
import { type LanguageModelMiddleware, wrapLanguageModel } from "ai";

import type { AgentModelTransport } from "./model-provider-config.js";
import { AppError } from "./app-error.js";
import { createMiniMaxAnthropicCompatibilityFetch } from "./minimax-anthropic-compatibility.js";
import { type ModelUsageLogContext, observeModelUsage } from "./model-usage-log.js";
import { describeDeepSeekHttpError } from "./deepseek/deepseek-errors.js";
import { normalizeDeepSeekResponsesRequest } from "./deepseek/deepseek-responses-request.js";
import {
  closeStrayProviderSearchCalls,
  isStrayProviderSearchCall,
  PROVIDER_SEARCH_FUNCTION_CALL_CODE,
  PROVIDER_SEARCH_TOOL_NAMES,
  strayProviderSearchResult,
} from "./provider-search-tool-call.js";

export interface ConfiguredLanguageModelOptions {
  readonly apiKey: string;
  readonly fetch?: FetchFunction;
  /** Billed usage of every successful response; production records it for the owner digest. */
  readonly onUsage?: ModelUsageLogContext["onUsage"];
  readonly maxOutputTokens: number;
  readonly modelId: string;
  readonly transport: AgentModelTransport;
}

const RETRYABLE_MODEL_HTTP_STATUS_CODES = new Set([408, 409, 429]);

function modelRequestUrl(input: Parameters<FetchFunction>[0]): string {
  const url = new URL(
    typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
  );
  // Query parameters are irrelevant to retry diagnosis and may contain provider credentials.
  return `${url.origin}${url.pathname}`;
}

function isRetryableModelResponse(response: Response): boolean {
  return RETRYABLE_MODEL_HTTP_STATUS_CODES.has(response.status) || response.status >= 500;
}

function normalizeDeepSeekThinkingRequest(
  options: ConfiguredLanguageModelOptions,
  init: RequestInit | undefined,
): RequestInit | undefined {
  const reasoning = options.transport.protocol === "openai-chat-completions"
    ? options.transport.reasoning
    : null;
  if (
    options.transport.protocol !== "openai-chat-completions"
    || options.transport.providerName !== "deepseek"
    || reasoning?.format !== "deepseek"
    || reasoning.type !== "effort"
    || typeof init?.body !== "string"
  ) {
    return init;
  }

  const body = JSON.parse(init.body) as Record<string, unknown>;
  const thinking = body.thinking as { type?: unknown } | undefined;
  if (thinking?.type !== "enabled" || body.tool_choice !== "auto") return init;
  delete body.tool_choice;
  return { ...init, body: JSON.stringify(body) };
}

function normalizeDeepSeekResponsesTransportRequest(
  options: ConfiguredLanguageModelOptions,
  init: RequestInit | undefined,
): RequestInit | undefined {
  if (options.transport.protocol !== "deepseek-responses") return init;
  const normalized = normalizeDeepSeekResponsesRequest(init, {
    effort: options.transport.reasoning.effort,
  });
  // Tool names only: enough to see whether the provider web search is offered on this call.
  if (typeof normalized?.body === "string") {
    try {
      const body = JSON.parse(normalized.body) as { tools?: Array<{ name?: unknown; type?: unknown }> };
      const tools = Array.isArray(body.tools)
        ? body.tools.map((tool) => typeof tool.name === "string" ? tool.name : String(tool.type))
        : [];
      console.log(JSON.stringify({
        code: "AGENT_MODEL_REQUEST",
        effort: options.transport.reasoning.effort,
        modelId: options.modelId,
        toolCount: tools.length,
        toolNames: tools.slice(0, 60),
        webSearchOffered: tools.includes("web_search") || tools.includes("web_search_2025_08_26"),
      }));
    } catch {
      // Diagnostics never block the call.
    }
  }
  return normalized;
}

function createCredentialGuardedFetch(options: ConfiguredLanguageModelOptions): FetchFunction {
  return async (input, init) => {
    if (!options.apiKey || /\s/u.test(options.apiKey)) {
      throw new AppError(
        "AGENT_MODEL_API_KEY_INVALID",
        "Не задан корректный ключ доступа к основной модели",
      );
    }
    const request = normalizeDeepSeekResponsesTransportRequest(options, normalizeDeepSeekThinkingRequest(options, init));
    let response = await (options.fetch ?? globalThis.fetch)(input, request);
    // A preview alias such as deepseek-v4.1-flash-expires-on-0910 dies on a date. When DeepSeek
    // answers that the configured id is not a supported model name, the same request goes once
    // more with the stable fallback, and the log says the configured id is gone.
    const retired = await retiredModelResponse(options, response);
    if (retired !== null) {
      console.error(JSON.stringify({
        code: "AGENT_MODEL_ID_RETIRED",
        fallbackModelId: retired,
        modelId: options.modelId,
        url: modelRequestUrl(input),
      }));
      response = await (options.fetch ?? globalThis.fetch)(input, withModelId(request, retired));
    }
    // Documented DeepSeek statuses become stable application errors; retryable ones keep flowing to
    // the AI SDK retry policy below, terminal ones stop the call with a human-readable reason.
    if (options.transport.protocol === "deepseek-responses" && !response.ok) {
      const described = describeDeepSeekHttpError(response.status);
      if (described !== null && !described.retryable) {
        console.error(JSON.stringify({
          code: described.code,
          modelId: options.modelId,
          statusCode: response.status,
          url: modelRequestUrl(input),
        }));
        throw new AppError(described.code, described.message);
      }
    }
    if (isRetryableModelResponse(response)) {
      console.error(JSON.stringify({
        code: "AGENT_MODEL_TRANSIENT_RESPONSE",
        modelId: options.modelId,
        statusCode: response.status,
        url: modelRequestUrl(input),
      }));
      return response;
    }
    // Provider-reported usage, including cache hits, is the baseline for prompt-cost work.
    return observeModelUsage(response, {
      modelId: options.modelId,
      ...(options.onUsage === undefined ? {} : { onUsage: options.onUsage }),
      url: modelRequestUrl(input),
    });
  };
}

const RETIRED_MODEL_MESSAGE = /supported API model names/iu;

/** The fallback id when the provider rejected the configured model as unknown, else null. */
async function retiredModelResponse(options: ConfiguredLanguageModelOptions, response: Response): Promise<string | null> {
  const transport = options.transport;
  if (transport.protocol !== "deepseek-responses" || response.status !== 400) return null;
  const fallback = transport.fallbackModelId;
  if (!fallback || fallback === options.modelId) return null;
  const text = await response.clone().text().catch(() => "");
  return RETIRED_MODEL_MESSAGE.test(text) && text.includes(options.modelId) ? fallback : null;
}

function withModelId(init: RequestInit | undefined, modelId: string): RequestInit | undefined {
  if (typeof init?.body !== "string") return init;
  try {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    return { ...init, body: JSON.stringify({ ...body, model: modelId }) };
  } catch {
    return init;
  }
}

function configuredProviderOptions(
  existing: SharedV4ProviderOptions | undefined,
  transport: AgentModelTransport,
): SharedV4ProviderOptions {
  if (transport.protocol === "anthropic-messages") {
    if (transport.reasoning == null) return {};
    if (transport.reasoning.type === "none") {
      // Omission delegates to the provider default (DeepSeek defaults to thinking enabled).
      // Explicit none must survive every tool step, including inherited provider options.
      return { anthropic: { ...existing?.anthropic, thinking: { type: "disabled" } } };
    }
    return {
      anthropic: {
        ...existing?.anthropic,
        thinking: { type: "adaptive" },
      },
    };
  }
  // DeepSeek Responses reasoning is applied on the wire from the documented contract.
  if (transport.protocol === "deepseek-responses") return {};
  if (transport.reasoning == null) return {};
  const reasoning = transport.reasoning;
  if (reasoning.format === "reasoning-object") {
    return {
      [transport.providerName]: {
        ...existing?.[transport.providerName],
        reasoning: reasoning.type === "none" ? { effort: "none" } : { effort: reasoning.effort },
      },
    };
  }
  if (reasoning.format === "reasoning-effort") {
    return {
      [transport.providerName]: {
        ...existing?.[transport.providerName],
        ...(transport.providerName === "groq"
          ? { parallelToolCalls: false, reasoningFormat: "parsed" }
          : {}),
        reasoningEffort: reasoning.type === "effort" ? reasoning.effort : "none",
      },
    };
  }
  return {
    [transport.providerName]: {
      ...existing?.[transport.providerName],
      ...(reasoning.type === "effort"
        ? { reasoningEffort: reasoning.effort }
        : {}),
      thinking: { type: reasoning.type === "effort" ? "enabled" : "disabled" },
    },
  };
}

function removeUnresolvedOpenAIToolCalls(prompt: LanguageModelV4Prompt): LanguageModelV4Prompt {
  // AI SDK treats a client-side approval as resolving its call, then removes the approval response
  // from provider input. OpenAI-compatible APIs require immediate results for every retained call.
  const normalized: LanguageModelV4Prompt = [];
  for (let index = 0; index < prompt.length;) {
    const message = prompt[index]!;
    if (message.role !== "assistant") {
      // A tool message outside its originating assistant group is invalid provider history.
      if (message.role !== "tool") normalized.push(message);
      index += 1;
      continue;
    }

    // Only contiguous tool messages can complete this assistant turn under Chat Completions.
    let nextIndex = index + 1;
    const toolMessages: Extract<LanguageModelV4Prompt[number], { role: "tool" }>[] = [];
    while (prompt[nextIndex]?.role === "tool") {
      toolMessages.push(prompt[nextIndex] as typeof toolMessages[number]);
      nextIndex += 1;
    }
    const immediateResultIds = new Set(toolMessages.flatMap((toolMessage) =>
      toolMessage.content
        .filter((part) => part.type === "tool-result")
        .map((part) => part.toolCallId)
    ));
    const retainedCallIds = new Set<string>();
    for (const part of message.content) {
      if (part.type === "tool-call" && immediateResultIds.has(part.toolCallId)) {
        retainedCallIds.add(part.toolCallId);
      }
    }
    const content = message.content.filter((part) =>
      part.type !== "tool-call" || retainedCallIds.has(part.toolCallId)
    );
    if (content.length > 0) normalized.push({ ...message, content });
    for (const toolMessage of toolMessages) {
      const toolContent = toolMessage.content.filter((part) =>
        part.type === "tool-approval-response" || retainedCallIds.has(part.toolCallId)
      );
      if (toolContent.length > 0) normalized.push({ ...toolMessage, content: toolContent });
    }
    index = nextIndex;
  }
  return normalized;
}

function createTransportDefaultsMiddleware(
  maxOutputTokens: number,
  transport: AgentModelTransport,
): LanguageModelMiddleware {
  return {
    specificationVersion: "v4",
    async transformParams({ params }) {
      return {
        ...params,
        maxOutputTokens: params.maxOutputTokens ?? maxOutputTokens,
        prompt: transport.protocol === "openai-chat-completions" ||
            transport.protocol === "deepseek-responses"
          ? removeUnresolvedOpenAIToolCalls(params.prompt)
          : params.prompt,
        providerOptions: {
          ...params.providerOptions,
          ...configuredProviderOptions(params.providerOptions, transport),
        },
      };
    },
    async wrapGenerate({ doGenerate }) {
      const result = await doGenerate();
      assertCompleteFinishReason(result.finishReason);
      return {
        ...result,
        content: closeStrayProviderSearchCalls(result.content, (toolCallId) => logStrayProviderSearch(transport, toolCallId)),
      };
    },
    async wrapStream({ doStream }) {
      const result = await doStream();
      return {
        ...result,
        stream: result.stream.pipeThrough(
          new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
            transform(part, controller) {
              if (part.type === "finish") assertCompleteFinishReason(part.finishReason);
              // A provider search tool returned as a function call has no local executor; the
              // call is re-labelled provider-executed and closed with an error result at once.
              if (part.type === "tool-input-start" && PROVIDER_SEARCH_TOOL_NAMES.has(part.toolName) && part.providerExecuted !== true) {
                controller.enqueue({ ...part, providerExecuted: true });
                return;
              }
              if (isStrayProviderSearchCall(part)) {
                logStrayProviderSearch(transport, part.toolCallId);
                controller.enqueue({ ...part, providerExecuted: true });
                controller.enqueue(strayProviderSearchResult(part));
                return;
              }
              controller.enqueue(part);
            },
          }),
        ),
      };
    },
  };
}

function logStrayProviderSearch(transport: AgentModelTransport, toolCallId: string): void {
  console.error(JSON.stringify({
    code: PROVIDER_SEARCH_FUNCTION_CALL_CODE,
    protocol: transport.protocol,
    toolCallId,
  }));
}

function assertCompleteFinishReason(finishReason: LanguageModelV4FinishReason): void {
  if (finishReason.unified === "stop" || finishReason.unified === "tool-calls") return;
  if (finishReason.unified === "length") {
    throw new AppError(
      "AGENT_MODEL_OUTPUT_TRUNCATED",
      "Модель оборвала ответ из-за ограничения длины. Сократите запрос или попросите ответить частями",
    );
  }
  if (finishReason.unified === "content-filter") {
    throw new AppError(
      "AGENT_MODEL_OUTPUT_FILTERED",
      "Модель остановила ответ из-за ограничений безопасности. Переформулируйте запрос",
    );
  }
  throw new AppError(
    "AGENT_MODEL_OUTPUT_INCOMPLETE",
    "Модель не завершила ответ. Попробуйте повторить запрос или сформулировать его иначе",
  );
}

export function createConfiguredLanguageModel(options: ConfiguredLanguageModelOptions) {
  const { transport } = options;
  const guardedFetch = createCredentialGuardedFetch(options);
  if (transport.protocol === "anthropic-messages") {
    const fetch = transport.compatibility === "minimax-anthropic"
      ? createMiniMaxAnthropicCompatibilityFetch(guardedFetch)
      : new URL(transport.baseUrl).hostname === "api.deepseek.com"
        ? deepSeekAnthropicSearchFetch(guardedFetch)
        : guardedFetch;
    const provider = createAnthropic({
      baseURL: transport.baseUrl,
      ...(transport.authentication === "bearer"
        ? { authToken: options.apiKey }
        : { apiKey: options.apiKey }),
      fetch,
    });
    return wrapLanguageModel({
      middleware: createTransportDefaultsMiddleware(options.maxOutputTokens, transport),
      model: provider(options.modelId),
    });
  }

  if (transport.protocol === "deepseek-responses") {
    const provider = createOpenAI({
      apiKey: options.apiKey,
      baseURL: transport.baseUrl,
      fetch: guardedFetch,
    });
    return wrapLanguageModel({
      middleware: createTransportDefaultsMiddleware(options.maxOutputTokens, transport),
      model: provider.responses(options.modelId),
    });
  }

  if (transport.providerName === "groq") {
    const provider = createGroq({
      apiKey: options.apiKey,
      baseURL: transport.baseUrl,
      fetch: guardedFetch,
    });
    return wrapLanguageModel({
      middleware: createTransportDefaultsMiddleware(options.maxOutputTokens, transport),
      model: provider(options.modelId),
    });
  }

  const provider = createOpenAICompatible({
    apiKey: options.apiKey,
    baseURL: transport.baseUrl,
    fetch: guardedFetch,
    name: transport.providerName,
  });
  return wrapLanguageModel({
    middleware: createTransportDefaultsMiddleware(options.maxOutputTokens, transport),
    model: provider.chatModel(options.modelId),
  });
}
