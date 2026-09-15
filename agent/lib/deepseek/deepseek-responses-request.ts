/**
 * DeepSeek Responses API request contract (api-docs.deepseek.com/guides/responses_api).
 *
 * Exports:
 * - `DeepSeekReasoningEffort`: documented effort levels; `none` disables thinking.
 * - `normalizeDeepSeekResponsesRequest`: applies the documented compatibility table to a request
 *   body produced by the AI SDK OpenAI Responses client.
 */
export type DeepSeekReasoningEffort = "high" | "low" | "max" | "none";

/** Request fields DeepSeek documents as unsupported or ignored; dropping them keeps the wire exact. */
export const DEEPSEEK_RESPONSES_UNSUPPORTED_FIELDS = [
  "background",
  "conversation",
  "include",
  "max_tool_calls",
  "metadata",
  "parallel_tool_calls",
  "previous_response_id",
  "prompt_cache_key",
  "prompt_cache_retention",
  "safety_identifier",
  "service_tier",
  "store",
  "truncation",
] as const;

/** Tool types DeepSeek executes or accepts; everything else is documented as ignored. */
const SUPPORTED_TOOL_TYPES = new Set(["function", "web_search", "web_search_2025_08_26"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeDeepSeekResponsesBody(
  body: Record<string, unknown>,
  options: { readonly effort: DeepSeekReasoningEffort; readonly userId?: string },
): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...body };
  for (const field of DEEPSEEK_RESPONSES_UNSUPPORTED_FIELDS) delete normalized[field];

  // `reasoning.effort` is the only reasoning control; `summary` is accepted but never produced.
  normalized.reasoning = { effort: options.effort };

  // `text.format` is honoured, `text.verbosity` is documented as a no-op.
  if (isRecord(normalized.text)) {
    const { verbosity: _verbosity, ...text } = normalized.text;
    if (Object.keys(text).length === 0) delete normalized.text;
    else normalized.text = text;
  }

  if (Array.isArray(normalized.tools)) {
    const tools = normalized.tools.filter((tool) =>
      isRecord(tool) && typeof tool.type === "string" && SUPPORTED_TOOL_TYPES.has(tool.type)
    );
    if (tools.length === 0) {
      delete normalized.tools;
      delete normalized.tool_choice;
    } else {
      normalized.tools = tools;
    }
  }

  // `user` drives content-safety, KV-cache and scheduling isolation on DeepSeek's side.
  if (options.userId !== undefined) normalized.user = options.userId;
  return normalized;
}

export function normalizeDeepSeekResponsesRequest(
  init: RequestInit | undefined,
  options: { readonly effort: DeepSeekReasoningEffort; readonly userId?: string },
): RequestInit | undefined {
  if (typeof init?.body !== "string") return init;
  let body: unknown;
  try {
    body = JSON.parse(init.body);
  } catch {
    return init;
  }
  if (!isRecord(body)) return init;
  return { ...init, body: JSON.stringify(normalizeDeepSeekResponsesBody(body, options)) };
}
