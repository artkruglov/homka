/**
 * Per-turn model step limit tests.
 *
 * Constructs covered:
 * - `resolveTurnModelStepLimitSelection`: permits calls below the configured boundary.
 * - Boundary enforcement: returns a fail-closed model instead of triggering Eve fallback.
 * - Invalid event/config state: blocks the model call with a stable diagnostic error.
 */
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";

import { resolveTurnModelStepLimitSelection } from "./turn-model-step-limit.js";

function modelFixture() {
  return {
    doGenerate: vi.fn(async () => {
      throw new Error("Unexpected upstream generate call");
    }),
    doStream: vi.fn(async () => {
      throw new Error("Unexpected upstream stream call");
    }),
    modelId: "test-model",
    provider: "test-provider",
    specificationVersion: "v4",
    supportedUrls: {},
  } satisfies LanguageModelV4;
}

describe("resolveTurnModelStepLimitSelection", () => {
  it("allows every model call below the zero-based step boundary", () => {
    const model = modelFixture();

    expect(resolveTurnModelStepLimitSelection({
      event: { data: { stepIndex: 31 }, type: "step.started" },
      maxModelSteps: 32,
      model,
      modelContextWindowTokens: 160_000,
    })).toBeNull();
  });

  it("blocks the model call at the boundary without invoking the upstream", async () => {
    const model = modelFixture();
    const selection = resolveTurnModelStepLimitSelection({
      event: { data: { stepIndex: 32 }, type: "step.started" },
      maxModelSteps: 32,
      model,
      modelContextWindowTokens: 160_000,
    });

    expect(selection).not.toBeNull();
    // Without the window Eve rejects the selection itself and fails the session, not the turn.
    expect(selection!.modelContextWindowTokens).toBe(160_000);
    await expect(selection!.model.doStream({} as never)).rejects.toThrow(
      "AGENT_TURN_MODEL_STEP_LIMIT_EXCEEDED",
    );
    await expect(selection!.model.doGenerate({} as never)).rejects.toThrow(
      "AGENT_TURN_MODEL_STEP_LIMIT_EXCEEDED",
    );
    expect(model.doStream).not.toHaveBeenCalled();
    expect(model.doGenerate).not.toHaveBeenCalled();
  });

  it.each([
    { event: {}, maxModelSteps: 32 },
    { event: { data: { stepIndex: -1 }, type: "step.started" }, maxModelSteps: 32 },
    { event: { data: { stepIndex: 0 }, type: "step.started" }, maxModelSteps: 0 },
  ])("fails closed for invalid step state %#", async ({ event, maxModelSteps }) => {
    const model = modelFixture();
    const selection = resolveTurnModelStepLimitSelection({
      event, maxModelSteps, model, modelContextWindowTokens: 160_000,
    });

    expect(selection).not.toBeNull();
    expect(selection!.modelContextWindowTokens).toBe(160_000);
    await expect(selection!.model.doStream({} as never)).rejects.toThrow(
      "AGENT_TURN_MODEL_STEP_STATE_INVALID",
    );
    expect(model.doStream).not.toHaveBeenCalled();
  });
});
