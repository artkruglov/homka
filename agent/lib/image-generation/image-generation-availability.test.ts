/**
 * Subscription image generation availability tests.
 *
 * Construct covered:
 * - `supportsSubscriptionImageGeneration`: enables the feature only for CLIProxy-backed Codex.
 */
import { describe, expect, it } from "vitest";

import { supportsSubscriptionImageGeneration, supportsImageGeneration, supportsOpenRouterImageGeneration } from "./image-generation-availability.js";

describe("subscription image generation availability", () => {
  it('enables independent OpenRouter images only with key and model', () => {
    expect(supportsOpenRouterImageGeneration({OPENROUTER_IMAGE_API_KEY:'key'})).toBe(false);
    expect(supportsOpenRouterImageGeneration({OPENROUTER_IMAGE_MODEL:'a/b'})).toBe(false);
    expect(supportsImageGeneration('deepseek',{OPENROUTER_IMAGE_API_KEY:'key',OPENROUTER_IMAGE_MODEL:'a/b'})).toBe(true);
  });
  it("requires the Codex subscription provider", () => {
    expect(supportsSubscriptionImageGeneration("codex-subscription")).toBe(true);
    for (const provider of [
      "deepseek",
      "groq",
      "minimax",
      "neuraldeep",
      "opencode-go",
      "openrouter",
    ] as const) {
      expect(supportsSubscriptionImageGeneration(provider)).toBe(false);
    }
  });
});
