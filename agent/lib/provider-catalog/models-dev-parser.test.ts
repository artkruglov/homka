/**
 * Models.dev metadata parser tests.
 *
 * Constructs covered:
 * - Empty reasoning metadata never implies a reasoning mode.
 * - Budget-token reasoning is excluded when the transport cannot express it.
 * - Unknown metadata option contracts fail fast instead of being silently ignored.
 */
import { describe, expect, it } from "vitest";

import { AppError } from "../app-error.js";
import { enrichModelsFromModelsDev } from "./models-dev-parser.js";

/** Creates one complete metadata model while allowing targeted reasoning overrides. */
function metadataCatalog(reasoningOptions: unknown[]): unknown {
  return {
    "opencode-go": {
      id: "opencode-go",
      models: {
        "qwen3.8-max": {
          id: "qwen3.8-max",
          limit: { context: 1_000_000, output: 65_536 },
          modalities: { input: ["text"], output: ["text"] },
          name: "Qwen3.8 Max",
          reasoning_options: reasoningOptions,
          tool_call: true,
        },
      },
      name: "OpenCode Go",
    },
  };
}

describe("enrichModelsFromModelsDev", () => {
  it.each([
    [[]],
    [[{ max: 262_144, type: "budget_tokens" }]],
    [[{ type: "effort", values: ["high"] }]],
  ])("does not invent an unsupported reasoning selection for %#", (reasoningOptions) => {
    const [model] = enrichModelsFromModelsDev(
      metadataCatalog(reasoningOptions),
      "opencode-go",
      [{ id: "qwen3.8-max", protocol: "anthropic-messages" }],
    );

    expect(model.reasoningOptions).toEqual([]);
  });

  it("keeps none for an OpenAI toggle when no provider-native enabled mode is expressible", () => {
    const catalog = metadataCatalog([{ type: "toggle" }]) as {
      "opencode-go": { models: Record<string, { id: string }> };
    };
    catalog["opencode-go"].models["deepseek-v4-flash"] = {
      ...catalog["opencode-go"].models["qwen3.8-max"],
      id: "deepseek-v4-flash",
    };

    const [model] = enrichModelsFromModelsDev(
      catalog,
      "opencode-go",
      [{ id: "deepseek-v4-flash", protocol: "openai-chat-completions" }],
    );

    expect(model.reasoningOptions).toEqual([{ type: "none" }]);
  });

  it("rejects an unknown reasoning option contract", () => {
    expect(() => enrichModelsFromModelsDev(
      metadataCatalog([{ type: "future-mode", value: true }]),
      "opencode-go",
      [{ id: "qwen3.8-max", protocol: "anthropic-messages" }],
    )).toThrow(expect.objectContaining<Partial<AppError>>({
      code: "AGENT_PROVIDER_METADATA_RESPONSE_INVALID",
    }));
  });
});
