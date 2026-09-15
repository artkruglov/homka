/** One paid Messages request with explicit search evidence; no retries or local web fetching. */
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { createHash } from "node:crypto";

export function evaluationFingerprint(configuration: unknown): string {
  return createHash("sha256").update(JSON.stringify(configuration)).digest("hex");
}

export async function evaluateSearchModel(model: LanguageModelV4, question: string, system: string) {
  const result = await model.doGenerate({
    abortSignal: AbortSignal.timeout(240_000),
    maxOutputTokens: 8_000,
    prompt: [{ role: "system", content: system },
      { role: "user", content: [{ type: "text", text: question }] }],
    toolChoice: { type: "auto" },
    tools: [{ type: "provider", name: "web_search", id: "anthropic.web_search_20250305", args: { maxUses: 3 } }],
  });
  const searchCalls = result.content.filter(part => part.type === "tool-call" &&
    part.toolName === "web_search" && part.providerExecuted).length;
  const answer = result.content.filter(part => part.type === "text").map(part => part.text).join("").trim();
  const sources = [...new Set(result.content.filter(part => part.type === "source" && part.sourceType === "url")
    .map(part => part.url))];
  const safeCodes = new Set(["max_uses_exceeded", "too_many_requests", "invalid_input", "query_too_long", "unavailable"]);
  const searchErrorCodes = result.content.flatMap(part => {
      if (part.type !== "tool-result" || !part.isError) return [];
      const value = part.result as { errorCode?: unknown } | null;
      const code = value && typeof value === "object" ? value.errorCode : undefined;
      return [typeof code === "string" && safeCodes.has(code) ? code : "unknown_error"];
    });
  const searchFailed = searchErrorCodes.length > 0;
  return {
    answer, searchCalls, sources, searchErrorCodes,
    evidenceFailure: searchFailed ? "provider_search_failed" : searchCalls === 0 ? "search_not_executed" :
      !answer ? "empty_answer" : result.finishReason.unified !== "stop" ? "incomplete_answer" : null,
  };
}
