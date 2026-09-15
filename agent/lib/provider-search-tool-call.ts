/**
 * Guard for a provider search tool that comes back as an ordinary function call.
 *
 * Exports:
 * - `PROVIDER_SEARCH_TOOL_NAMES`: the provider-executed search tools Eve may offer.
 * - `PROVIDER_SEARCH_FUNCTION_CALL_CODE`: the log code when the guard fires.
 * - `isStrayProviderSearchCall`: a `web_search` tool call that no local executor can answer.
 * - `strayProviderSearchResult`: the provider-executed error result that closes such a call.
 *
 * Key construct:
 * - DeepSeek runs `web_search` on its side and normally reports it as a `web_search_call` item.
 *   Once, next to three parallel function calls, it returned `web_search` as a `function_call`
 *   with empty arguments. Nothing local executes that name, so the assistant message kept a tool
 *   call without a result and every later model call in the session failed with
 *   `AI_MissingToolResultsError`; the chat stayed silent until the session was rotated by hand.
 *   Marking the call provider-executed and closing it with an error result keeps the history
 *   valid, and the model reads a plain error instead of an answer that never comes.
 */
import type { LanguageModelV4Content, LanguageModelV4StreamPart } from "@ai-sdk/provider";

export const PROVIDER_SEARCH_TOOL_NAMES: ReadonlySet<string> = new Set(["web_search", "web_search_2025_08_26"]);
export const PROVIDER_SEARCH_FUNCTION_CALL_CODE = "AGENT_MODEL_PROVIDER_SEARCH_AS_FUNCTION_CALL";

type ToolCallPart = Extract<LanguageModelV4StreamPart, { type: "tool-call" }>;
type ToolResultPart = Extract<LanguageModelV4StreamPart, { type: "tool-result" }>;

export function isStrayProviderSearchCall(part: { type: string }): part is ToolCallPart {
  return part.type === "tool-call" &&
    PROVIDER_SEARCH_TOOL_NAMES.has((part as ToolCallPart).toolName) &&
    (part as ToolCallPart).providerExecuted !== true;
}

export function strayProviderSearchResult(call: ToolCallPart): ToolResultPart {
  // A provider-level tool result is provider-executed by definition; the AI SDK marks it so.
  return {
    isError: true,
    result: {
      code: PROVIDER_SEARCH_FUNCTION_CALL_CODE,
      reason: "Провайдер вернул серверный поиск как обычный вызов функции без результата. " +
        "Повторите поиск отдельным шагом или ответьте без него.",
    },
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    type: "tool-result",
  };
}

/** Closes stray search calls inside a non-streaming result; other content is returned as is. */
export function closeStrayProviderSearchCalls(
  content: readonly LanguageModelV4Content[],
  onStray: (toolCallId: string) => void,
): LanguageModelV4Content[] {
  const closed: LanguageModelV4Content[] = [];
  for (const part of content) {
    if (!isStrayProviderSearchCall(part)) {
      closed.push(part);
      continue;
    }
    onStray(part.toolCallId);
    closed.push({ ...part, providerExecuted: true }, strayProviderSearchResult(part));
  }
  return closed;
}
