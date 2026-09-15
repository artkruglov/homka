/**
 * Interactive model configuration command tests.
 *
 * Constructs covered:
 * - `runInteractiveConfigCommand`: selects, smokes, and atomically applies one live provider model.
 * - No apply before successful smoke and explicit optional voice selection.
 */
import { describe, expect, it, vi } from "vitest";

import type { NormalizedModel, PromptAdapter } from "./contracts.js";
import { runInteractiveConfigCommand } from "./config-command.js";

const model: NormalizedModel = {
  contextWindowTokens: 64_000,
  defaultReasoningOption: { type: "none" },
  displayName: "Router Model",
  id: "vendor/router-model",
  maxOutputTokens: 8_000,
  protocol: "openai-chat-completions",
  reasoningOptions: [{ type: "none" }, { effort: "high", type: "effort" }],
  supportsImageInput: false,
  supportsTools: true,
};

function prompts(): PromptAdapter {
  return {
    confirm: vi.fn().mockResolvedValue(false),
    secret: vi.fn().mockResolvedValue("model-key"),
    select: vi.fn()
      .mockResolvedValueOnce("openrouter")
      .mockResolvedValueOnce(model.id)
      .mockResolvedValueOnce("effort:high"),
    text: vi.fn(),
  };
}

describe("runInteractiveConfigCommand", () => {
  it("smokes and applies the exact selected model configuration", async () => {
    const apply = vi.fn().mockResolvedValue({ primaryModelId: model.id, provider: "openrouter" });
    const validateModel = vi.fn();

    await expect(runInteractiveConfigCommand({
      apply,
      listModels: vi.fn().mockResolvedValue([model]),
      prompts: prompts(),
      validateGroq: vi.fn(),
      validateModel,
    })).resolves.toEqual({ primaryModelId: model.id, provider: "openrouter" });

    expect(validateModel).toHaveBeenCalledWith(
      "openrouter", "model-key", model, { effort: "high", type: "effort" },
    );
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({
      groqApiKey: undefined,
      modelApiKey: "model-key",
    }));
    const config = JSON.parse(vi.mocked(apply).mock.calls[0]?.[0].configBytes.toString("utf8"));
    expect(config).toMatchObject({ provider: "openrouter", schemaVersion: 4, voice: { enabled: false } });
  });

  it("never applies when the real model smoke fails", async () => {
    const apply = vi.fn();

    await expect(runInteractiveConfigCommand({
      apply,
      listModels: vi.fn().mockResolvedValue([model]),
      prompts: prompts(),
      validateGroq: vi.fn(),
      validateModel: vi.fn().mockRejectedValue(new Error("smoke failed")),
    })).rejects.toThrow("smoke failed");
    expect(apply).not.toHaveBeenCalled();
  });
});
