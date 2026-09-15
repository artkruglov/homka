/**
 * DeepSeek Responses request contract tests.
 *
 * Constructs covered:
 * - Unsupported fields from the documented compatibility table are dropped.
 * - reasoning.effort is the only reasoning control and always comes from configuration.
 * - Unsupported tool types are removed; function and web_search tools stay.
 * - Non-JSON bodies pass through untouched.
 */
import { describe, expect, it } from "vitest";

import {
  normalizeDeepSeekResponsesBody,
  normalizeDeepSeekResponsesRequest,
} from "./deepseek-responses-request.js";
import { describeDeepSeekHttpError } from "./deepseek-errors.js";

describe("deepseek responses request", () => {
  it("applies the documented compatibility table", () => {
    const body = normalizeDeepSeekResponsesBody({
      include: ["reasoning.encrypted_content"],
      input: "привет",
      max_output_tokens: 100,
      metadata: { a: "b" },
      model: "deepseek-v4-flash",
      parallel_tool_calls: true,
      reasoning: { effort: "low", summary: "auto" },
      store: false,
      text: { format: { type: "text" }, verbosity: "low" },
      tool_choice: "auto",
      tools: [
        { name: "get_time", parameters: {}, type: "function" },
        { type: "web_search" },
        { type: "file_search" },
      ],
      truncation: "auto",
    }, { effort: "high", userId: "family-1" });

    expect(body).toEqual({
      input: "привет",
      max_output_tokens: 100,
      model: "deepseek-v4-flash",
      reasoning: { effort: "high" },
      text: { format: { type: "text" } },
      tool_choice: "auto",
      tools: [
        { name: "get_time", parameters: {}, type: "function" },
        { type: "web_search" },
      ],
      user: "family-1",
    });
  });

  it("drops tool_choice together with the last unsupported tool and keeps non-JSON bodies", () => {
    expect(normalizeDeepSeekResponsesBody(
      { model: "m", tool_choice: "required", tools: [{ type: "mcp" }] },
      { effort: "none" },
    )).toEqual({ model: "m", reasoning: { effort: "none" } });
    const init = { body: "not json", method: "POST" };
    expect(normalizeDeepSeekResponsesRequest(init, { effort: "low" })).toBe(init);
  });

  it("describes documented statuses with stable codes and retryability", () => {
    expect(describeDeepSeekHttpError(402)).toMatchObject({ code: "AGENT_MODEL_BALANCE_EXHAUSTED", retryable: false });
    expect(describeDeepSeekHttpError(503)).toMatchObject({ retryable: true });
    expect(describeDeepSeekHttpError(418)).toBeNull();
  });
});
